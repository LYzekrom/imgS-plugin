import fetch from 'node-fetch';
import { FormData } from 'formdata-polyfill/esm.min.js';
import { fileFromSync } from 'fetch-blob/from.js';
import downloadImage from '../utils/download.js';
import Config from './Config.js';
import Jimp from 'jimp';

const BASE_URL = 'https://api.animetrace.com';

let modelListCache = null;

async function AnimeTrace(url) {
    const imagePath = await downloadImage(url);

    const form = new FormData();
    form.append('file', fileFromSync(imagePath));
    form.append('model', await getModel());
    form.append('is_multi', (await Config.getConfig().AnimeTrace.mode) ? '1' : '0');
    form.append('ai_detect', '1');
    return await request(form, imagePath);
}

async function getModel() {
    const preferred = await Config.getConfig().AnimeTrace.model;
    try {
        if (!modelListCache) {
            modelListCache = await fetch(`${BASE_URL}/v1/model/list`).then((res) => res.json());
        }
        if (modelListCache.code === 0) {
            const enabled = modelListCache.data.filter((model) => model.enabled);
            if (enabled.some((model) => model.id === preferred)) return preferred;
            const def = enabled.find((model) => model.default) || enabled[0];
            if (def) return def.id;
        }
    } catch (error) {
        logger.error('[AnimeTrace] 获取模型列表失败：' + error);
    }
    return preferred;
}

async function request(form, imagePath) {
    const response = await fetch(`${BASE_URL}/v1/search`, {
        method: 'POST',
        body: form
    }).then(res => res.json());

    if (response.code === 0) {
        return await parse(response.data, imagePath);
    }
    logger.error('[AnimeTrace] 接口返回错误：' + JSON.stringify(response));
    throw new Error('请求失败');
}

async function parse(response, imagePath) {
    if (await Config.getConfig().AnimeTrace.preview) {
        let image;
        try {
            image = await Jimp.read(imagePath);
            const width = image.getWidth();
            const height = image.getHeight();
            for (let i = 0; i < response.length; i++) {
                const box = response[i].box;
                const newImage = image.clone();
                // 裁切图片
                newImage.crop(
                    width * box[0],
                    height * box[1],
                    width * (box[2] - box[0]),
                    height * (box[3] - box[1])
                );
                response[i].preview = (await newImage.getBase64Async(Jimp.AUTO)).split(',')[1];
            }
        } catch (error) {
            for (let i = 0; i < response.length; i++) {
                response[i].preview = 'fail unsupport image type';
            }
        }
    }
    return response.map((data) => ({
        box: data.box,
        not_confident: data.not_confident,
        characters: (data.character || []).map((item) => ({
            work: item.work,
            character: item.character
        })),
        preview: data.preview
    }));
}

export { AnimeTrace };
