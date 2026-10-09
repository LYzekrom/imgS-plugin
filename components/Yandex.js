import fetch from 'node-fetch';
import { FormData } from 'formdata-polyfill/esm.min.js';
import { fileFromSync } from 'fetch-blob/from.js';
import { load } from 'cheerio';
import _ from 'lodash';
import downloadImage from '../utils/download.js';
import Config from './Config.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fetchHtml, runInPage } from '../utils/browser.js';

const BASE_URL = 'https://yandex.com/';
const UPLOAD_REQUEST = '{"blocks":[{"block":"b-page_type_search-by-image__link"}]}';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

async function Yandex(url) {

    let agent = null
    if (Config.getConfig().proxy.enable) {
        let proxy = 'http://' + Config.getConfig().proxy.host + ':' + Config.getConfig().proxy.port
        agent = new HttpsProxyAgent(proxy)
    }

    const cookie = await Config.getConfig().Yandex.cookie

    const imagePath = await downloadImage(url);
    if (!imagePath) {
        throw new Error('下载待搜索图片失败');
    }

    let body = null;

    // 1. node-fetch 上传图片（Yandex 收图后返回 cbir_id 结果页地址）
    try {
        const form = new FormData();
        form.append('upfile', fileFromSync(imagePath), 'blob');
        const uploadResult = await fetch(`${BASE_URL}images/search?rpt=imageview&format=json&request=${encodeURIComponent(UPLOAD_REQUEST)}`, {
            method: 'POST',
            agent: agent,
            headers: {
                cookie: cookie ?? '',
                'user-agent': BROWSER_UA,
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: form,
        }).then((res) => res.json());
        const resultPath = uploadResult?.blocks?.[0]?.params?.url;
        if (resultPath) {
            body = await fetch(new URL(resultPath, BASE_URL).toString(), {
                headers: { cookie: cookie ?? '', 'user-agent': BROWSER_UA },
                agent: agent,
            }).then((res) => res.text());
        }
    } catch (error) {
        logger.info(`[Yandex] 上传接口请求失败，尝试浏览器上传：${error.message}`);
    }

    // 2. 浏览器兜底：页面上下文下载图片并上传，真浏览器指纹
    if (!body) {
        logger.info('[Yandex] 尝试通过浏览器上传搜索');
        const cbirPath = await runInPage(`${BASE_URL}images/`, cookie, async (imageUrl) => {
            try {
                const imgRes = await fetch(imageUrl);
                if (!imgRes.ok) return null;
                const blob = await imgRes.blob();
                const form = new FormData();
                form.append('upfile', blob, 'blob');
                const upRes = await fetch(`/images/search?rpt=imageview&format=json&request=${encodeURIComponent('{"blocks":[{"block":"b-page_type_search-by-image__link"}]}')}`, {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest' },
                    body: form,
                });
                const data = await upRes.json();
                return data?.blocks?.[0]?.params?.url ?? null;
            } catch {
                return null;
            }
        }, url).catch((error) => {
            logger.error('[Yandex] 浏览器上传失败：' + error);
            return null;
        });
        if (cbirPath) {
            body = await fetchHtml(new URL(cbirPath, BASE_URL).toString(), cookie).catch(() => null);
        }
    }

    if (!body) {
        throw new Error('Yandex 搜索失败，上传接口与浏览器均未返回结果');
    }
    if (body.includes('Please confirm that you are not a robot')) {
        throw new Error('被人机验证拦截，请更新 Yandex cookie 后重试');
    }

    const results = parse(body);
    logger.info(`[Yandex] 解析到 ${results.length} 条结果（页面 ${body.length} 字符，含 serp-item: ${body.includes('serp-item')}）`);
    return results;
}

function parse(body) {
    const $ = load(body, { decodeEntities: true });
    return _.map($('.serp-list .serp-item'), (item) => {
        return JSON.parse($(item).attr('data-bem'))['serp-item'];
    }).filter((value) => value !== undefined);
}

export { Yandex };
