// Resolve the site language before scripts construct their translated labels.
// Every form is handled by script. Block native submission so an Enter press
// before the handlers attach cannot send form fields to the page URL as a GET query.
document.addEventListener('submit', (event) => event.preventDefault(), true);

const APP_SCRIPTS = ['crypto', 'crypto_sync', 'api', 'components', 'auth', 'upload', 'filemanager', 'sidebar-tree', 'admin_panel', 'app'];

// Download application scripts while the language request is in flight.
for (const name of APP_SCRIPTS) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'script';
    link.href = `/js/${name}.js`;
    document.head.appendChild(link);
}

(async () => {
    await I18n.init();
    // async=false keeps execution in list order while downloads run in parallel.
    await Promise.all(APP_SCRIPTS.map((name) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = `/js/${name}.js`;
        script.async = false;
        script.onload = resolve;
        script.onerror = () => reject(new Error(`Failed to load /js/${name}.js`));
        document.body.appendChild(script);
    })));
    App.init();
})().catch((error) => {
    console.error('FreeDrive startup failed', error);
    const message = document.createElement('p');
    message.textContent = I18n.t('Startup failed. Reload this page to try again.');
    message.setAttribute('role', 'alert');
    document.body.prepend(message);
});
