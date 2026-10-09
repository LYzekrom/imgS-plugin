import fetch from 'node-fetch';
import { load } from 'cheerio';
import _ from 'lodash';
import Config from './Config.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { fetchHtml } from '../utils/browser.js';

const BASE_URL = 'https://yandex.com/';

async function Yandex(url) {

    let agent = null
    if (Config.getConfig().proxy.enable) {
        let proxy = 'http://' + Config.getConfig().proxy.host + ':' + Config.getConfig().proxy.port
        agent = new HttpsProxyAgent(proxy)
    }

    const cookie = await Config.getConfig().Yandex.cookie

    const requestUrl = `${BASE_URL}images/search?cbir_page=similar&rpt=imageview&url=${encodeURIComponent(url)}`;

    let body = await fetch(requestUrl, {
        headers: { cookie: cookie ?? '' },
        agent: agent,
    }).then((res) => res.text());

    if (body.includes('Please confirm that you are not a robot')) {
        logger.info('[Yandex] 触发人机验证，尝试通过浏览器搜索');
        body = await fetchHtml(requestUrl, cookie).catch((error) => {
            logger.error('[Yandex] 浏览器搜索失败：' + error);
            return null;
        });
        if (!body) {
            throw new Error('浏览器搜索失败，请求 URL: ' + requestUrl);
        }
        if (body.includes('Please confirm that you are not a robot')) {
            throw new Error('浏览器仍被人机验证拦截，请更新 Yandex cookie 后重试');
        }
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
