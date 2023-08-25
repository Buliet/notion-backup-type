#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */

let axios = require('axios')
    , extract = require('extract-zip')
    , { retry } = require('async')
    , { createWriteStream } = require('fs')
    , { mkdir, rm, readdir } = require('fs/promises')
    , { join } = require('path')
    , notionAPI = 'https://www.notion.so/api/v3'
    , { NOTION_TOKEN, NOTION_FILE_TOKEN, NOTION_SPACE_ID, EXPORT_TYPE } = process.env
    , client = axios.create({
        baseURL: notionAPI,
        headers: {
            Cookie: `token_v2=${NOTION_TOKEN}; file_token=${NOTION_FILE_TOKEN}`
        },
    })
    , die = (str) => {
        console.error(str);
        process.exit(1);
    }
    ;

if (!NOTION_TOKEN || !NOTION_FILE_TOKEN || !NOTION_SPACE_ID) {
    die(`Need to have NOTION_TOKEN, NOTION_FILE_TOKEN and NOTION_SPACE_ID defined in the environment.
See https://github.com/darobin/notion-backup/blob/main/README.md for
a manual on how to get that information.`);
}

// EXPORT_TYPE should be "", markdown, or html
// If empty, both types will be exported
if (!EXPORT_TYPE) {
    EXPORT_TYPE = "";
}

async function post(endpoint, data) {
    return client.post(endpoint, data);
}

async function sleep(seconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, seconds * 1000);
    });
}

// formats: markdown, html
async function exportFromNotion(format) {
    try {
        let { data: { taskId } } = await post('enqueueTask', {
            task: {
                eventName: 'exportSpace',
                request: {
                    spaceId: NOTION_SPACE_ID,
                    exportOptions: {
                        exportType: format,
                        timeZone: 'America/New_York',
                        locale: 'en',
                    },
                },
            },
        });
        console.warn(`Enqueued task ${taskId}`);
        let failCount = 0
            , exportURL
            ;
        while (true) {
            if (failCount >= 5) break;
            await sleep(10);
            let { data: { results: tasks } } = await retry(
                { times: 3, interval: 2000 },
                async () => post('getTasks', { taskIds: [taskId] })
            );
            let task = tasks.find(t => t.id === taskId);
            // console.warn(JSON.stringify(task, null, 2)); // DBG
            if (!task) {
                failCount++;
                console.warn(`No task, waiting.`);
                continue;
            }
            if (!task.status) {
                failCount++;
                console.warn(`No task status, waiting. Task was:\n${JSON.stringify(task, null, 2)}`);
                continue;
            }
            if (task.state === 'in_progress') console.warn(`Pages exported: ${task.status.pagesExported}`);
            if (task.state === 'failure') {
                failCount++;
                console.warn(`Task error: ${task.error}`);
                continue;
            }
            if (task.state === 'success') {
                exportURL = task.status.exportURL;
                break;
            }
        }
        let res = await client({
            method: 'GET',
            url: exportURL,
            responseType: 'stream'
        });
        let stream = res.data.pipe(createWriteStream(join(process.cwd(), `${format}.zip`)));
        await new Promise((resolve, reject) => {
            stream.on('close', resolve);
            stream.on('error', reject);
        });
    }
    catch (err) {
        die(err);
    }
}

async function run() {

    switch (EXPORT_TYPE.toLowerCase()) {
        case 'markdown':
            console.log("Exporting", EXPORT_TYPE.toLowerCase());
            await exportExtract('markdown');
            break;

        case 'html':
            console.log("Exporting", EXPORT_TYPE.toLowerCase());
            await exportExtract('html');
            break;

        default:
            console.log("No export format specified. Exporting markdown and html");
            let [r1, r2] = await Promise.all([
                exportExtract('markdown'),
                exportExtract('html')
            ])
    }
}

async function exportExtract(format) {
    let cwd = process.cwd(),
        dir = join(cwd, format),
        file = join(cwd, format + '.zip');
    await exportFromNotion(format);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await extract(file, { dir: dir });
    await extractInnerZip(dir);
}


async function extractInnerZip(dir) {
    let files = (await readdir(dir)).filter(fn => /Part-\d+\.zip$/i.test(fn));
    for (let file of files) {
        await extract(join(dir, file), { dir });
    }
}

run();

