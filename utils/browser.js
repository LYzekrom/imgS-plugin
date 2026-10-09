import puppeteer from 'puppeteer';

let browser = null;

async function getBrowser() {
    if (browser && browser.connected) return browser;
    browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browser.on('disconnected', () => {
        browser = null;
    });
    return browser;
}

/**
 * 在真实浏览器上下文中下载远程图片并转为 base64
 * 用于规避 Cloudflare 等基于客户端指纹的下载拦截
 * @param {string} url 图片地址
 * @param {string} referer 先访问的页面地址（与图片同源时可绕过跨域限制）
 * @returns {Promise<string|null>} base64:// 开头的图片数据，失败返回 null
 */
async function urlToBase64(url, referer) {
    const page = await (await getBrowser()).newPage();
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

export { urlToBase64 };
