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

let flareCache = null;

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

    let flareHeaders = null;
    let colorResponse = await fetch(requestUrl, {
        method: 'POST',
        body: form,
        agent: agent,
    });

    let errorBody = '';
    if (colorResponse.status === 403) {
        errorBody = await colorResponse.text();
    }

    if (errorBody.includes('Just a moment')) {
        logger.info('[Ascii2d] 触发 Cloudflare 验证，尝试通过 FlareSolverr 获取凭证');
        flareHeaders = await getFlareHeaders();
        if (flareHeaders) {
            colorResponse = await fetch(requestUrl, {
                method: 'POST',
                body: form,
                agent: agent,
                headers: flareHeaders,
            });
            errorBody = colorResponse.status === 200 ? '' : await colorResponse.text();
            if (colorResponse.status !== 200) flareCache = null;
        }
    }

    logger.info(`[Ascii2d] 响应状态：HTTP ${colorResponse.status} ${colorResponse.statusText}，最终 URL：${colorResponse.url}`);

    if (colorResponse.status === 200) {
        let response;
        if (type === 'color') {
            response = await colorResponse.text();
        } else {
            const bovwUrl = colorResponse.url.replace('/color/', '/bovw/');
            response = await fetch(bovwUrl, flareHeaders ? { headers: flareHeaders } : {}).then((res) => res.text());
        }
        return parse(response);
    } else {
        if (!errorBody) errorBody = await colorResponse.text();
        logger.error(`[Ascii2d] 请求失败，响应内容：${errorBody.slice(0, 500)}`);
        throw new Error('[Ascii2d] 请求失败，可能触发了Cloudflare的验证机制，请稍后再试');
    }
}

async function getFlareHeaders() {
    const flare = Config.getConfig().FlareSolverr;
    if (!flare?.enable) return null;
    if (flareCache && flareCache.expire > Date.now()) return flareCache.headers;
    try {
        const result = await fetch(flare.url.replace(/\/$/, '') + '/v1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cmd: 'request.get',
                url: BASE_URL,
                maxTimeout: 60000,
            }),
        }).then((res) => res.json());
        if (result.status !== 'ok') {
            logger.error('[Ascii2d] FlareSolverr 请求失败：' + JSON.stringify(result).slice(0, 300));
            return null;
        }
        const cookie = result.solution.cookies
            .filter((item) => item.domain.includes('ascii2d.net'))
            .map((item) => `${item.name}=${item.value}`)
            .join('; ');
        if (!cookie.includes('cf_clearance')) {
            logger.error('[Ascii2d] FlareSolverr 未返回 cf_clearance：' + JSON.stringify(result.solution.cookies));
            return null;
        }
        flareCache = {
            headers: {
                cookie: cookie,
                'user-agent': result.solution.userAgent,
            },
            expire: Date.now() + 10 * 60 * 1000,
        };
        return flareCache.headers;
    } catch (error) {
        logger.error('[Ascii2d] FlareSolverr 连接失败：' + error);
        return null;
    }
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
            image: new URL(image.attribs['src'] ?? image.attribs['data-cfsrc'], BASE_URL).toString(),
            source: source ? { link: source.attribs.href, text: $(source).text() } : undefined,
            author: author ? { link: author.attribs.href, text: $(author).text() } : undefined,
        };
    }).filter((value) => value !== undefined);
}

export { Ascii2d };
