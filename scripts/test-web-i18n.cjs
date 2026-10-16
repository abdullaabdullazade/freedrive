// Run with Node.js 20+: node --test scripts/test-web-i18n.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const web = path.resolve(__dirname, '../cmd/freedrive/web');

async function environment(siteLanguage = 'zh-CN') {
    const storage = new Map([['fd_language', 'zh-CN']]);
    const fields = new Map();
    const context = vm.createContext({
        Intl, Date, AbortSignal, URLSearchParams, TextDecoder, console,
        localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        navigator: { languages: ['zh-CN', 'en'] },
        document: { documentElement: {}, querySelectorAll: () => [], getElementById: key => fields.get(key) },
        fetch: async () => ({ ok: true, json: async () => ({ language: siteLanguage }) }),
        window: { location: { origin: 'http://localhost' } },
    });
    function load(file, expose = '') {
        let code = fs.readFileSync(path.join(web, file), 'utf8');
        if (expose) {
            const index = code.lastIndexOf('    return {');
            code = code.slice(0, index) + code.slice(index).replace('    return {', `    return { __test: { ${expose} },`);
        }
        vm.runInContext(code, context, { filename: file });
    }
    load('locales/zh-CN.js'); load('js/i18n.js'); load('js/components.js');
    const i18n = vm.runInContext('I18n', context);
    await i18n.init();
    return { context, fields, load, i18n };
}

test('Chinese locale aliases and English defaults, independent of browser preferences', async () => {
    const { i18n } = await environment();
    for (const value of ['zh', 'zh-CN', 'zh_CN', 'zh-SG', 'zh-Hans', 'zh-Hans-CN']) assert.equal(i18n.normalize(value), 'zh-CN');
    assert.equal(i18n.resolve('en'), 'en');
    assert.equal(i18n.resolve('zh-CN'), 'zh-CN');
    for (const value of [null, '', 'az', 'tr', 'de', 'unknown']) assert.equal(i18n.resolve(value), 'en');
    assert.equal(i18n.normalize('zh-Hant'), null);
});

test('site default is resolved before rendering and failed config reads still initialize', async () => {
    const a = await environment('en');
    await a.i18n.init();
    assert.equal(a.i18n.t('Sign in'), 'Sign in');
    assert.equal(a.context.document.documentElement.lang, 'en');
    const b = await environment('');
    b.context.fetch = async () => { throw new Error('offline'); };
    await b.i18n.init();
    assert.equal(b.i18n.t('Sign in'), 'Sign in');
});

test('translation interpolation preserves names, dollar signs, and HTML characters', async () => {
    const { i18n } = await environment();
    const name = '<Home & Download> $& $\' $`';
    assert.equal(i18n.t('Share {0}', [name]), '分享 ' + name);
    assert.equal(i18n.t('Home.txt'), 'Home.txt');
    assert.equal(i18n.t('Missing key {0}', ['文件']), 'Missing key 文件');
    assert.equal(i18n.t('{0} {1} selected', [3, 'items']), '已选择 3 项');
    assert.equal(i18n.t('toString'), 'toString');
    const english = await environment('en');
    assert.equal(english.i18n.t('Share {0}', [name]), 'Share ' + name);
});

test('known API errors translate without altering underlying error identifiers', async () => {
    const { i18n } = await environment();
    assert.equal(i18n.error('quota exceeded'), '已超出存储配额');
    assert.equal(i18n.error('failed to send email: SMTP 550'), '发送邮件失败：SMTP 550');
    assert.equal(i18n.error('custom server error'), 'custom server error');
    assert.equal(i18n.error('Request failed (503)'), '请求失败（503）');
    assert.equal(i18n.error('Upload rolled back because its encryption key could not be synced: Network error'), '由于无法同步加密密钥，已回滚上传：网络错误');
    assert.equal(i18n.label('viewer'), '查看者');
    assert.equal(i18n.label('suspended'), '已停用');
    assert.equal(i18n.label('create'), '创建');
    assert.equal(i18n.label('unshare'), '取消分享');
});

test('English relative times and home dates keep the original presentation', async () => {
    const e = await environment('en');
    const components = vm.runInContext('Components', e.context);
    const now = Date.now();
    assert.equal(components.formatDate(new Date(now - 60 * 60 * 1000).toISOString()), '1 hr ago');
    assert.equal(components.formatDate(new Date(now - 2 * 60 * 60 * 1000).toISOString()), '2 hrs ago');
    assert.equal(components.formatDate(new Date(now - 24 * 60 * 60 * 1000).toISOString()), '1 day ago');
    e.load('js/filemanager.js', 'formatHomeReasonDate');
    const manager = vm.runInContext('FileManager', e.context);
    assert.equal(manager.__test.formatHomeReasonDate(new Date(2020, 0, 2)), '2 Jan 2020');
});

test('English labels retain the original raw values and context-specific capitalization', async () => {
    const { i18n } = await environment('en');
    assert.equal(i18n.label('admin'), 'admin');
    assert.equal(i18n.label('upload'), 'upload');
    assert.equal(i18n.label('active', 'Active'), 'Active');
    assert.equal(i18n.label('user', 'USER'), 'USER');
});

test('local activity preserves historical actors, filenames and legacy records in either language', async () => {
    const activity = { text: 'Original User uploaded Home <文件>.txt', action: 'uploaded', filename: 'Home <文件>.txt' };
    for (const language of ['en', 'zh-CN']) {
        const e = await environment(language);
        e.load('js/filemanager.js', 'localActivityText, formatAction');
        const manager = vm.runInContext('FileManager', e.context).__test;
        assert.equal(manager.localActivityText(activity), language === 'en' ? activity.text : 'Original User 上传了 Home <文件>.txt');
        assert.equal(manager.localActivityText({ text: 'Legacy User edited Home.txt' }), 'Legacy User edited Home.txt');
        assert.equal(manager.localActivityText({ ...activity, text: 'Unrecognized legacy format' }), 'Unrecognized legacy format');
        if (language === 'en') assert.equal(manager.formatAction('create'), 'create');
    }
});

test('bootstrap loads the original application scripts after language resolution and initializes once', async () => {
    const events = [];
    const listeners = [];
    let finishLanguage;
    const languageReady = new Promise(resolve => { finishLanguage = resolve; });
    const context = vm.createContext({
        I18n: { init: async () => { await languageReady; events.push('language'); }, t: value => value },
        App: { init: () => events.push('app') }, console,
        document: {
            addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }),
            createElement: () => ({}),
            head: { appendChild: link => events.push(`preload ${link.href}`) },
            body: { appendChild: script => { events.push(script.src); queueMicrotask(() => script.onload()); } },
        },
    });
    const completed = vm.runInContext(fs.readFileSync(path.join(web, 'js/bootstrap.js'), 'utf8'), context);
    const scripts = ['crypto', 'crypto_sync', 'api', 'components', 'auth', 'upload', 'filemanager', 'sidebar-tree', 'admin_panel', 'app'];
    // Downloads start before language resolution; nothing executes yet.
    assert.deepEqual(events, scripts.map(name => `preload /js/${name}.js`));
    events.length = 0;
    // Native form submission is blocked before the application handlers attach.
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].type, 'submit');
    assert.equal(listeners[0].capture, true);
    let prevented = false;
    listeners[0].listener({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    finishLanguage();
    await completed;
    assert.deepEqual(events, ['language', ...scripts.map(name => `/js/${name}.js`), 'app']);
});

test('the Chinese catalog is downloaded only for Chinese sites and failures fall back to English', async () => {
    for (const [siteLanguage, loadFails, expected, requested] of [['en', false, 'en', []], ['zh-CN', false, 'zh-CN', ['/locales/zh-CN.js']], ['zh-CN', true, 'en', ['/locales/zh-CN.js']]]) {
        const requests = [];
        const context = vm.createContext({
            AbortSignal, Intl,
            fetch: async () => ({ ok: true, json: async () => ({ language: siteLanguage }) }),
            document: {
                documentElement: {}, querySelectorAll: () => [],
                createElement: () => ({}),
                head: { appendChild: script => {
                    requests.push(script.src);
                    if (loadFails) return queueMicrotask(() => script.onerror(new Error('offline')));
                    vm.runInContext(fs.readFileSync(path.join(web, 'locales/zh-CN.js'), 'utf8'), context);
                    queueMicrotask(() => script.onload());
                } },
            },
        });
        vm.runInContext(fs.readFileSync(path.join(web, 'js/i18n.js'), 'utf8'), context);
        const i18n = vm.runInContext('I18n', context);
        await i18n.init();
        assert.equal(i18n.language, expected);
        assert.deepEqual(requests, requested);
        assert.equal(i18n.t('Sign in'), expected === 'en' ? 'Sign in' : '登录');
    }
});

test('Chinese search labels preserve the English API option values', async () => {
    const e = await environment();
    e.load('js/filemanager.js', 'HOME_CHIP_DEFS, getStorageCategory');
    const manager = vm.runInContext('FileManager', e.context);
    for (const [id, value] of Object.entries({
        'filter-type': 'Documents', 'filter-owner': 'Specific person', 'filter-owner-email': 'user@example.com',
        'filter-location': 'My Drive', 'filter-modified': 'Custom', 'filter-modified-from': '2026-10-01',
    })) e.fields.set(id, { value });
    const parameters = manager.collectAdvancedSearchParams();
    assert.equal(parameters.type, 'Documents'); assert.equal(parameters.location, 'My Drive');
    assert.equal(parameters.modified, 'Custom'); assert.equal(parameters.owner, 'Specific person');
    assert.equal(parameters.owner_email, 'user@example.com');
    const defs = manager.__test.HOME_CHIP_DEFS;
    assert.equal(defs[0].options[0], 'Photos');
    assert.equal(manager.__test.getStorageCategory('image/png', '中文.png'), 'Images');
    assert.equal(manager.__test.getStorageCategory('text/plain', 'Home.txt'), 'Documents');
});

test('admin storage data keeps its original bucket keys under Chinese', async () => {
    const e = await environment();
    e.load('js/admin_panel.js', 'bucketsFromApiBreakdown');
    const admin = vm.runInContext('AdminPanel', e.context);
    const buckets = admin.__test.bucketsFromApiBreakdown({ images: { size: 123, count: 2 }, documents: { size: 456, count: 1 } });
    assert.equal(buckets.Images.size, 123); assert.equal(buckets.Documents.count, 1);
    assert.equal(Object.hasOwn(buckets, '图片'), false);
});

test('authored translation keys have Chinese entries and icon names stay intact', async () => {
    const e = await environment();
    const catalog = vm.runInContext('FD_LOCALES["zh-CN"]', e.context);
    const missing = new Set();
    for (const name of fs.readdirSync(path.join(web, 'js'))) {
        const source = fs.readFileSync(path.join(web, 'js', name), 'utf8');
        for (const match of source.matchAll(/I18n\.t\(("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g)) {
            const key = vm.runInNewContext(match[1]);
            if (!Object.hasOwn(catalog, key)) missing.add(key);
        }
        assert.doesNotMatch(source, /class="[^"\n]*material-icons[^"\n]*"[^>]*>\$\{I18n\.t/, name);
    }
    const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
    for (const match of html.matchAll(/data-i18n(?:-(?:title|placeholder|aria-label|content))?="([^"]*)"/g)) {
        const key = match[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
        if (!Object.hasOwn(catalog, key)) missing.add(key);
    }
    assert.deepEqual([...missing], []);
});

test('device names, enum labels and prefixed server errors are translated without touching user data', async () => {
    const { i18n } = await environment();
    assert.equal(i18n.device('Chrome on Linux'), 'Linux 上的 Chrome');
    assert.equal(i18n.device('Browser on Unknown OS'), '未知系统 上的 浏览器');
    assert.equal(i18n.device('Desktop app'), '桌面应用');
    assert.equal(i18n.device("Alice's Chrome on Linux"), "Alice's Chrome on Linux");
    for (const [value, expected] of [['guest', '访客'], ['owner', '所有者'], ['success', '成功'], ['failed', '失败'], ['copy', '复制'], ['cancelled', '已取消']]) {
        assert.equal(i18n.label(value), expected, value);
    }
    assert.equal(i18n.error('failed to send email: smtp server does not support STARTTLS'), '发送邮件失败：SMTP 服务器不支持 STARTTLS');
    assert.equal(i18n.error('failed to send email: dial tcp 10.0.0.1:25: i/o timeout'), '发送邮件失败：dial tcp 10.0.0.1:25：连接超时');
    assert.equal(i18n.error('rate limit exceeded'), '请求过于频繁，请稍后再试');
});

test('English keeps device names and labels as they were', async () => {
    const { i18n } = await environment('en');
    assert.equal(i18n.device('Chrome on Linux'), 'Chrome on Linux');
    assert.equal(i18n.label('guest'), 'guest');
    assert.equal(i18n.error('rate limit exceeded'), 'rate limit exceeded');
});

test('notifications are translated when rendered and keep English text for icon detection', async () => {
    for (const language of ['zh-CN', 'en']) {
        const e = await environment(language);
        e.load('js/filemanager.js', 'notificationText, notifIconType');
        const { notificationText, notifIconType } = vm.runInContext('FileManager.__test', e.context);
        const keyed = { text: 'File uploaded successfully', i18n: { key: 'File uploaded successfully', values: {} } };
        assert.equal(notificationText(keyed), language === 'en' ? 'File uploaded successfully' : '文件上传成功');
        assert.equal(notifIconType(keyed.text), 'upload');
        const server = { text: 'failed_login — Admin', action: 'failed_login', target_name: 'Admin', target_type: 'user' };
        assert.equal(notificationText(server), language === 'en' ? 'failed_login — Admin' : '登录失败 — Admin');
        assert.equal(notificationText({ ...server, target_name: '' }), language === 'en' ? 'failed_login — Admin' : '登录失败 — 用户');
        assert.equal(notificationText({ text: 'Legacy text' }), 'Legacy text');
    }
});

test('public share downloads keep Chinese and quoted file names', () => {
    const source = fs.readFileSync(path.join(web, 'js/app.js'), 'utf8');
    const fn = /    function dispositionFilename\(disposition\) \{[\s\S]*?\n    \}\n/.exec(source)[0];
    const dispositionFilename = vm.runInNewContext(`(${fn.trim()})`);
    assert.equal(dispositionFilename("attachment; filename*=utf-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A.txt"), '季度 报告.txt');
    assert.equal(dispositionFilename('attachment; filename=report.pdf'), 'report.pdf');
    assert.equal(dispositionFilename('attachment; filename="say \\"hi\\".txt"'), 'say "hi".txt');
    assert.equal(dispositionFilename("attachment; filename*=utf-8''%E0%A4%A"), '');
    assert.equal(dispositionFilename(''), '');
});

test('Chinese sites sort names by pinyin; English keeps the browser default', async () => {
    const zh = (await environment()).i18n;
    assert.equal(zh.collation, 'zh-CN');
    assert.deepEqual(['张', '安', '李', '王', '波'].sort((a, b) => a.localeCompare(b, zh.collation)), ['安', '波', '李', '王', '张']);
    assert.equal((await environment('en')).i18n.collation, undefined);
});

test('ZIP downloads mark entry names as UTF-8 so Chinese names extract intact', async () => {
    const source = fs.readFileSync(path.join(web, 'js/filemanager.js'), 'utf8');
    const grab = (start, end) => { const i = source.indexOf(start); return source.slice(i, source.indexOf(end, i) + end.length); };
    const fn = (name) => { const i = source.indexOf(`    function ${name}(`); let depth = 0; for (let k = source.indexOf('{', i); k < source.length; k++) { if (source[k] === '{') depth++; else if (source[k] === '}' && !--depth) return source.slice(i, k + 1); } };
    const code = [grab('    const zipCrcTable', '})();'), grab('    const ZIP_UTF8_FLAG', ';'), ...['crc32', 'dosDateTime', 'concatUint8', 'createZipBlob'].map(fn)].join('\n');
    const createZipBlob = vm.runInNewContext(`${code}\ncreateZipBlob`, { TextEncoder, Blob, Uint8Array, DataView, Date });
    const bytes = new Uint8Array(await createZipBlob([
        { path: '季度 报告.txt', data: new TextEncoder().encode('内容'), modifiedAt: new Date() },
        { path: '文件夹/', data: new Uint8Array(0), modifiedAt: new Date() },
    ]).arrayBuffer());
    const view = new DataView(bytes.buffer);
    assert.equal(view.getUint16(6, true) & 0x0800, 0x0800);
    const nameLength = view.getUint16(26, true);
    assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + nameLength)), '季度 报告.txt');
    const central = bytes.findIndex((_, i) => view.getUint32(i, true) === 0x02014b50);
    assert.equal(view.getUint16(central + 4, true) >> 8, 3, 'made by Unix');
    assert.equal(view.getUint16(central + 8, true) & 0x0800, 0x0800);
    assert.equal(view.getUint32(central + 38, true) >>> 16, 0o100644);
});

test('IME composition keys are recognised so Enter and Escape do not act mid-composition', async () => {
    const { context } = await environment();
    const components = vm.runInContext('Components', context);
    assert.equal(components.isComposing({ key: 'Enter', isComposing: true }), true);
    assert.equal(components.isComposing({ key: 'Process', keyCode: 229 }), true);
    assert.equal(components.isComposing({ key: 'Enter', keyCode: 13 }), false);
    assert.equal(components.isComposing(undefined), false);
});

test('word count treats each Chinese character as a word and keeps English counts', () => {
    const source = fs.readFileSync(path.join(web, 'js/filemanager.js'), 'utf8');
    const start = source.indexOf('    const WORD_TOKEN');
    const end = source.indexOf('\n    }\n', source.indexOf('function countWords', start)) + 6;
    const countWords = vm.runInNewContext(`${source.slice(start, end)}\ncountWords`);
    const oldCount = (text) => (text.trim().match(/\S+/g) || []).length;
    for (const text of ['', 'hello world', "  don't stop - now  ", 'a—b c', 'v1.2 x@y.z']) assert.equal(countWords(text), oldCount(text), text);
    assert.equal(countWords('你好世界，欢迎使用 FreeDrive。'), 9);
    assert.equal(countWords('季度报告2026'), 5);
    assert.equal(countWords('「重要」：请查看'), 5);
});

test('text files decode as UTF-8, UTF-16 or (on Chinese sites) GBK, and Chinese CSV gets a BOM for Excel', async () => {
    const gbk = new Uint8Array([188, 190, 182, 200, 44, 177, 168, 184, 230, 10, 49, 44, 182, 254]); // "季度,报告\n1,二" in GBK
    const zh = (await environment()).context;
    const components = vm.runInContext('Components', zh);
    assert.equal(await components.decodeText(new Blob([gbk])), '季度,报告\n1,二');
    assert.equal(await components.decodeText(new Blob(['﻿季度,报告'])), '季度,报告');
    assert.equal(await components.decodeText(new Blob([new Uint8Array([0xff, 0xfe, 0x63, 0x5b, 0xa6, 0x5e])])), '季度');
    assert.equal(await components.decodeText(new Blob(['plain ascii'])), 'plain ascii');
    const en = vm.runInContext('Components', (await environment('en')).context);
    assert.equal(await en.decodeText(new Blob([gbk])), new TextDecoder().decode(gbk), 'English sites keep the previous UTF-8 decoding');
    assert.equal(components.csvForExcel('a,b\n1,2'), 'a,b\n1,2');
    assert.equal(components.csvForExcel('名称,大小'), '﻿名称,大小');
    assert.equal(components.csvForExcel('﻿名称'), '﻿名称');
});

test('system error details are translated while paths and hosts are kept', async () => {
    const { i18n } = await environment();
    assert.equal(i18n.error('failed to create backup: mkdir /var/lib/freedrive: permission denied'), '创建备份失败：mkdir /var/lib/freedrive：权限不足');
    assert.equal(i18n.error('failed to send email: dial tcp 10.0.0.1:25: i/o timeout'), '发送邮件失败：dial tcp 10.0.0.1:25：连接超时');
    assert.equal(i18n.error('dial tcp: lookup smtp.example.com: no such host'), 'dial tcp: lookup smtp.example.com：找不到主机');
    assert.equal(i18n.error('something else entirely'), 'something else entirely');
    const en = (await environment('en')).i18n;
    assert.equal(en.error('mkdir /x: permission denied'), 'mkdir /x: permission denied');
});

test('JSON and browser network errors are shown in Chinese', async () => {
    const { i18n } = await environment();
    for (const source of ['abc', '{a:1}', '[1,]']) {
        try { JSON.parse(source); } catch (err) { assert.match(i18n.error(err.message), /^JSON 语法错误/); }
    }
    assert.equal(i18n.error('Failed to fetch'), '网络连接失败，请检查网络后重试');
    assert.equal(i18n.error('signal timed out'), '请求超时');
});
