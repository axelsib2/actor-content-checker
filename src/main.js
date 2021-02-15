const Apify = require('apify');

const screenshotDOMElement = require('./screenshot');
const validateInput = require('./validate-input');

const { log, sleep } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getInput();
    validateInput(input);

    const {
        url,
        contentSelector,
        sendNotificationTo,
        // if screenshotSelector is not defined, use contentSelector for screenshot
        screenshotSelector = contentSelector,
        sendNotificationText,
        proxy = {
            useApifyProxy: false
        },
        navigationTimeout = 30000,
    } = input;

    // define name for a key-value store based on task ID or actor ID
    // (to be able to have more content checkers under one Apify account)
    let storeName = 'content-checker-store-';
    storeName += !process.env.APIFY_ACTOR_TASK_ID ? process.env.APIFY_ACT_ID : process.env.APIFY_ACTOR_TASK_ID;

    // use or create a named key-value store
    const store = await Apify.openKeyValueStore(storeName);

    // get data from previous run
    const previousScreenshot = await store.getValue('currentScreenshot.png');
    const previousData = await store.getValue('currentData');
    const proxyConfiguration = await Apify.createProxyConfiguration(proxy);

    // open page in a browser
    log.info('Launching Puppeteer...');
    const browser = await Apify.launchPuppeteer({
        proxyUrl: proxyConfiguration ? proxyConfiguration.newUrl() : undefined,
    });

    log.info(`Opening URL: ${url}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 920 });
    await page.goto(url, {
        waitUntil: 'networkidle2',
        timeout: navigationTimeout,
    });

    // wait 5 seconds (if there is some dynamic content)
    // TODO: this should wait for the selector to be available
    await page.waitForSelector(contentSelector,{
            timeout:navigationTimeout
        });
    await page.evaluate((contentSelector) => {
        return document.querySelector(contentSelector).scrollIntoView();
    }, contentSelector)
    
    // Store a screenshot
    log.info('Saving screenshot...');
    let screenshotBuffer = null;
    try {
        let elem = await page.$(contentSelector);
        screenshotBuffer = await elem.screenshot({encoding:'base64'});
    } catch (e) {
        throw new Error('Cannot get screenshot (screenshot selector is probably wrong)');
    }
    await store.setValue('currentScreenshot.png', screenshotBuffer, { contentType: 'image/png' });

    // Store data
    log.info('Saving data...');
    let content = null;
    try {
        content = await page.$eval(contentSelector, (el) => el.textContent);
    } catch (e) {
        throw new Error('Cannot get content (content selector is probably wrong)');
    }

    log.info(`Previous data: ${previousData}`);
    log.info(`Current data: ${content}`);
    await store.setValue('currentData', content);

    log.info('Closing Puppeteer...');
    await browser.close();

    log.info('Done.');

    if (previousScreenshot === null) {
        log.warning('Running for the first time, no check');
    } else {
        // store data from this run
        await store.setValue('previousScreenshot.png', previousScreenshot, { contentType: 'image/png' });
        await store.setValue('previousData', previousData);

        // check data
        if (previousData === content) {
            log.warning('No change');
        } else {
            log.warning('Content changed');

            const notificationNote = sendNotificationText ? `Note: ${sendNotificationText}\n\n` : '';

            // send mail
            log.info('Sending mail...');
            await Apify.call('apify/send-mail', {
                to: sendNotificationTo,
                subject: 'Apify content checker - page changed!',
                text: `URL: ${url}\n\n${notificationNote}Previous data: ${previousData}\n\nCurrent data: ${content}`,
                attachments: [
                    {
                        filename: 'previousScreenshot.png',
                        data: previousScreenshot.toString('base64'),
                    },
                    {
                        filename: 'currentScreenshot.png',
                        data: screenshotBuffer.toString('base64'),
                    },
                ],

            });
        }
    }

    log.info('You can check the output in the named key-value store on the following URLs:');
    log.info(`- https://api.apify.com/v2/key-value-stores/${store.storeId}/records/currentScreenshot.png`);
    log.info(`- https://api.apify.com/v2/key-value-stores/${store.storeId}/records/currentData`);

    if (previousScreenshot !== null) {
        log.info(`- https://api.apify.com/v2/key-value-stores/${store.storeId}/records/previousScreenshot.png`);
        log.info(`- https://api.apify.com/v2/key-value-stores/${store.storeId}/records/previousData`);
    }
    //save output 
    const output={
        change: previousData === content? false:true,
        previousData: previousData,
        currentData:content,
        newScreenshotUrl:`https://api.apify.com/v2/key-value-stores/${store.storeId}/records/currentScreenshot.png`
    }
    await Apify.setValue('OUTPUT', output);
    
});
