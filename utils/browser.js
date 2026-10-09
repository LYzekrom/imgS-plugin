import puppeteer from 'puppeteer';
import Config from '../components/Config.js';

let browser = null;

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

async function getBrowser() {
    if (browser && browser.connected) return browser;
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
    ];
    try {
        const proxy = Config.getConfig()?.proxy;
        if (proxy?.enable) {
            args.push(`--proxy-server=http://${proxy.host}:${proxy.port}`);
        }
    } catch {
        // 配置不可用时直连
    }
    browser = await puppeteer.launch({
        headless: true,
        args: args,
    });
    browser.on('disconnected', () => {
        browser = null;
    });
    return browser;
}

// 抹除无头浏览器的自动化标记，避免被反爬识别（如 Yandex 的 captcha）
async function newPage() {
    const page = await (await getBrowser()).newPage();
    await page.setUserAgent(CHROME_UA);
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    return page;
}

/**
 * 在真实浏览器上下文中下载远程图片并转为 base64
 * 用于规避 Cloudflare 等基于客户端指纹的下载拦截
 * @param {string} url 图片地址
 * @param {string} referer 先访问的页面地址（与图片同源时可绕过跨域限制）
 * @returns {Promise<string|null>} base64:// 开头的图片数据，失败返回 null
 */
async function urlToBase64(url, referer) {
    const page = await newPage();
    try {
        await page.goto(referer ?? url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        const base64 = await page.evaluate(async (u) => {
            try {
                const res = await fetch(u);
                if (!res.ok) return null;
                const buf = new Uint8Array(await res.arrayBuffer());
                let bin = '';
                const chunk = 0x8000;
                for (let i = 0; i < buf.length; i += chunk) {
                    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
                }
                return btoa(bin);
            } catch {
                return null;
            }
        }, url);
        return base64 ? `base64://${base64}` : null;
    } finally {
        await page.close().catch(() => { });
    }
}

async function setPageCookie(page, cookie, url) {
    const domain = '.' + new URL(url).hostname;
    const cookies = cookie.split(';').map((pair) => {
        const idx = pair.indexOf('=');
        return idx > 0 ? {
            name: pair.slice(0, idx).trim(),
            value: pair.slice(idx + 1).trim(),
            domain: domain,
        } : null;
    }).filter(Boolean);
    if (cookies.length) await page.setCookie(...cookies);
}

/**
 * 在真实浏览器中打开页面并返回渲染后的完整 HTML
 * 用于规避基于客户端指纹的人机验证（如 Yandex）
 * @param {string} url 页面地址
 * @param {string} cookie 可选，"k=v; k=v" 格式，会注入 .yandex.com 域名下
 * @returns {Promise<string>} 页面 outerHTML
 */
async function fetchHtml(url, cookie) {
    const page = await newPage();
    try {
        if (cookie) {
            await setPageCookie(page, cookie, url);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        return await page.evaluate(() => document.documentElement.outerHTML);
    } finally {
        await page.close().catch(() => { });
    }
}

/**
 * 在真实浏览器页面上下文中执行异步函数
 * @param {string} url 先访问的页面地址（提供同源上下文）
 * @param {string} cookie 可选，注入 .yandex.com 域名下
 * @param {Function} fn 在页面内执行的函数，可携带额外参数
 * @returns {Promise<any>} fn 的返回值
 */
async function runInPage(url, cookie, fn, ...args) {
    const page = await newPage();
    try {
        if (cookie) {
            await setPageCookie(page, cookie, url);
        }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return await page.evaluate(fn, ...args);
    } finally {
        await page.close().catch(() => { });
    }
}

export { urlToBase64, fetchHtml, runInPage };
