import fetch from 'node-fetch';
import { FormData } from 'formdata-polyfill/esm.min.js';
import { load } from 'cheerio';
import { fileFromSync } from 'fetch-blob/from.js';
import downloadImage from '../utils/download.js';
import _ from 'lodash';
import Config from './Config.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

const PROXY_URL = 'https://ascii2d.obfs.dev';
const BASE_URL = 'https://ascii2d.net';

async function Ascii2d(url) {
    const imagePath = await downloadImage(url);

    const form = new FormData();
    form.append('file', fileFromSync(imagePath));

    let agent = null
    if (Config.getConfig().proxy.enable) {
        let proxy = 'http://' + Config.getConfig().proxy.host + ':' + Config.getConfig().proxy.port
        agent = new HttpsProxyAgent(proxy)
    }

    const type = await Config.getConfig().Ascii2d.type;
    const proxy = await Config.getConfig().Ascii2d.proxy;

    const requestUrl = `${proxy ? PROXY_URL : BASE_URL}/search/file`;
    logger.info(`[Ascii2d] 请求 URL：${requestUrl}，代理：${agent ? '启用' : '未启用'}`);

    const colorResponse = await fetch(requestUrl, {
        method: 'POST',
        body: form,
        agent: agent,
    });

    let errorBody = '';
    if (colorResponse.status === 403) {
        errorBody = await colorResponse.text();
    }

    if (errorBody.includes('Just a moment')) {
        logger.info('[Ascii2d] 触发 Cloudflare 验证，尝试通过 FlareSolverr 搜索');
        const flareResult = await searchByFlareSolverr(url, type);
        if (flareResult) return parse(flareResult);
    }

    logger.info(`[Ascii2d] 响应状态：HTTP ${colorResponse.status} ${colorResponse.statusText}，最终 URL：${colorResponse.url}`);

    if (colorResponse.status === 200) {
        let response;
        if (type === 'color') {
            response = await colorResponse.text();
        } else {
            const bovwUrl = colorResponse.url.replace('/color/', '/bovw/');
            response = await fetch(bovwUrl).then((res) => res.text());
        }
        return parse(response);
    } else {
        if (!errorBody) errorBody = await colorResponse.text();
        logger.error(`[Ascii2d] 请求失败，响应内容：${errorBody.slice(0, 500)}`);
        throw new Error('[Ascii2d] 请求失败，可能触发了Cloudflare的验证机制，请稍后再试');
    }
}

async function searchByFlareSolverr(imageUrl, type) {
    const flare = Config.getConfig().FlareSolverr;
    if (!flare?.enable) return null;
    try {
        let result = await flareRequest(`${BASE_URL}/search/url/${encodeURIComponent(imageUrl)}`);
        if (!result) return null;
        if (type !== 'color' && result.url.includes('/color/')) {
            result = await flareRequest(result.url.replace('/color/', '/bovw/')) || result;
        }
        return result.html;
    } catch (error) {
        logger.error('[Ascii2d] FlareSolverr 搜索失败：' + error);
        return null;
    }
}

async function flareRequest(url) {
    const flare = Config.getConfig().FlareSolverr;
    const result = await fetch(flare.url.replace(/\/$/, '') + '/v1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cmd: 'request.get',
            url: url,
            maxTimeout: 90000,
        }),
    }).then((res) => res.json());
    if (result.status !== 'ok') {
        logger.error('[Ascii2d] FlareSolverr 请求失败：' + JSON.stringify(result).slice(0, 300));
        return null;
    }
    if (result.solution.response.includes('Just a moment')) {
        logger.error('[Ascii2d] FlareSolverr 未能通过 Cloudflare 验证');
        return null;
    }
    return { html: result.solution.response, url: result.solution.url };
}

function parse(body) {
    const $ = load(body, { decodeEntities: true });
    return _.map($('.item-box'), (item) => {
        const detail = $('.detail-box', item),
            hash = $('.hash', item),
            info = $('.info-box > .text-muted', item),
            [image] = $('.image-box > img', item),
            [source, author] = $('a[rel=noopener]', detail);

        if (!source && !author) return;

        return {
            hash: hash.text(),
            info: info.text(),
            image: urlToBase64(new URL(image.attribs['src'] ?? image.attribs['data-cfsrc'], BASE_URL).toString()),
            source: source ? { link: source.attribs.href, text: $(source).text() } : undefined,
            author: author ? { link: author.attribs.href, text: $(author).text() } : undefined,
        };
    }).filter((value) => value !== undefined);
}

/**
 * 统一的 fetch 请求方法，带重试机制
 * @param {string} url - 请求URL
 * @param {object} options - fetch 选项
 * @param {number} retries - 重试次数，默认3次
 * @param {string} context - 请求上下文（用于日志）
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retries = 3, context = '') {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            return response;
        } catch (error) {
            const isLastAttempt = i === retries - 1;
            if (isLastAttempt) {
                logger.error(`[Ascii2d搜图] ${context} 请求失败，已重试${retries}次: ${error}`);
                this.logProxyInfo();
                throw error;
            }
            // 递增延迟：1s, 2s, 3s...
            const delay = 1000 * (i + 1);
            logger.warn(`[Ascii2d搜图] ${context} 请求失败，${delay}ms后第${i + 2}次重试: ${error.message}`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

/**
* @description 将图片URL内容转换为Base64字符串
* @param {string} url 图片的URL
* @returns {Promise<string>} Base64编码的图片数据URI
*/
async function urlToBase64(url) {
    try {
        const response = await fetchWithRetry(url, {
            timeout: 60000,
        }, 3, `下载图片转Base64`);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const buffer = await response.buffer();
        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const base64 = buffer.toString('base64');
        return `data:${contentType};base64,${base64}`;
    } catch (error) {
        logger.error(`[Ascii2d搜图] URL转Base64失败: ${url}, Error: ${error}`);
        return "";
    }
}
export { Ascii2d };
