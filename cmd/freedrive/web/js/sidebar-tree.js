const SidebarTree = (() => {
    const ROOT_KEY = '__root__';
    const STORAGE_KEY = 'fd_sidebar_tree_expanded';

    const expandedIds = new Set();
    const childrenCache = new Map();
    let currentFolderId = null;
    let renderToken = 0;

    const FOLDER_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

    function esc(text) {
        return Components?.escapeHtml ? Components.escapeHtml(text) : String(text || '');
    }

    function folderKey(folderId) {
        return folderId == null ? ROOT_KEY : folderId;
    }

    function loadExpandedState() {
        try {
            const raw = sessionStorage.getItem(STORAGE_KEY);
            if (!raw) return;
            JSON.parse(raw).forEach((id) => expandedIds.add(id));
        } catch {
            expandedIds.clear();
        }
    }

    function saveExpandedState() {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...expandedIds]));
    }

    function isExpanded(key) {
        return expandedIds.has(key);
    }

    async function fetchChildren(folderId) {
        const key = folderKey(folderId);
        if (childrenCache.has(key)) return childrenCache.get(key);

        const data = folderId ? await API.folders.get(folderId) : await API.folders.root();
        const folders = Array.isArray(data.folders) ? data.folders : [];
        childrenCache.set(key, folders);
        return folders;
    }

    function updateRootChevron() {
        const chevron = document.getElementById('nav-my-drive-chevron');
        const tree = document.getElementById('nav-my-drive-tree');
        if (!chevron || !tree) return;

        const expanded = isExpanded(ROOT_KEY);
        chevron.classList.toggle('is-expanded', expanded);
        chevron.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        chevron.setAttribute('aria-label', expanded ? 'Collapse My Drive folders' : 'Expand My Drive folders');
        tree.classList.toggle('hidden', !expanded);
    }

    function createChevron(folderId, hasKnownEmpty) {
        const key = folderKey(folderId);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nav-tree-chevron';
        const expanded = isExpanded(key);
        if (expanded) btn.classList.add('is-expanded');
        if (hasKnownEmpty) btn.classList.add('is-hidden');
        btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        btn.setAttribute('aria-label', expanded ? 'Collapse folder' : 'Expand folder');
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await toggleExpand(folderId);
        });
        return btn;
    }

    async function renderFolderNode(folder, container) {
        const key = folder.id;
        const node = document.createElement('div');
        node.className = 'nav-tree-node';
        node.dataset.folderId = folder.id;

        const row = document.createElement('div');
        row.className = 'nav-tree-folder';
        if (currentFolderId === folder.id) row.classList.add('active');

        const cached = childrenCache.get(key);
        const hasKnownEmpty = cached && cached.length === 0;
        row.appendChild(createChevron(folder.id, hasKnownEmpty));

        const link = document.createElement('a');
        link.href = `#/files/${folder.id}`;
        link.className = 'nav-tree-folder-link';
        link.innerHTML = `${FOLDER_ICON}<span>${esc(folder.name)}</span>`;
        row.appendChild(link);

        const childrenEl = document.createElement('div');
        childrenEl.className = 'nav-tree-children';
        if (!isExpanded(key)) childrenEl.classList.add('hidden');

        node.appendChild(row);
        node.appendChild(childrenEl);
        container.appendChild(node);

        if (isExpanded(key)) {
            const children = cached || await fetchChildren(folder.id);
            for (const child of children) {
                await renderFolderNode(child, childrenEl);
            }
        }
    }

    async function renderTree() {
        const token = ++renderToken;
        const tree = document.getElementById('nav-my-drive-tree');
        if (!tree) return;

        updateRootChevron();
        tree.innerHTML = '';

        if (!isExpanded(ROOT_KEY)) return;

        const rootChildren = childrenCache.get(ROOT_KEY) || await fetchChildren(null);
        if (token !== renderToken) return;

        for (const folder of rootChildren) {
            await renderFolderNode(folder, tree);
            if (token !== renderToken) return;
        }

        applyActiveState();
    }

    function applyActiveState() {
        document.querySelectorAll('.nav-tree-folder.active').forEach((el) => el.classList.remove('active'));
        if (!currentFolderId) return;
        document.querySelector(`.nav-tree-node[data-folder-id="${currentFolderId}"] .nav-tree-folder`)?.classList.add('active');
    }

    async function toggleExpand(folderId) {
        const key = folderKey(folderId);
        if (isExpanded(key)) {
            expandedIds.delete(key);
        } else {
            expandedIds.add(key);
            await fetchChildren(folderId);
        }
        saveExpandedState();
        await renderTree();
    }

    async function expandPathTo(folderId) {
        if (!folderId) return;

        expandedIds.add(ROOT_KEY);
        await fetchChildren(null);

        try {
            const data = await API.folders.breadcrumb(folderId);
            const crumbs = data.breadcrumb || [];
            for (let i = 0; i < crumbs.length - 1; i += 1) {
                expandedIds.add(crumbs[i].id);
                await fetchChildren(crumbs[i].id);
            }
        } catch {
            // Ignore breadcrumb errors; route still works.
        }

        saveExpandedState();
        await renderTree();
    }

    function clearActiveFolders() {
        document.querySelectorAll('.nav-tree-folder.active').forEach((el) => el.classList.remove('active'));
    }

    function syncWithRoute() {
        const hash = window.location.hash || '#/files';
        if (!hash.startsWith('#/files')) {
            currentFolderId = null;
            applyActiveState();
            return;
        }

        const parts = hash.split('/');
        currentFolderId = parts[2] || null;

        if (currentFolderId) {
            expandPathTo(currentFolderId);
            return;
        }

        renderTree();
    }

    async function refresh(parentId = null) {
        const key = folderKey(parentId);
        childrenCache.delete(key);
        if (isExpanded(key)) {
            await fetchChildren(parentId);
        }
        await renderTree();
    }

    function invalidateCache(parentId) {
        childrenCache.delete(folderKey(parentId ?? null));
    }

    function invalidateAll() {
        expandedIds.clear();
        childrenCache.clear();
        currentFolderId = null;
        sessionStorage.removeItem(STORAGE_KEY);
        updateRootChevron();
        const tree = document.getElementById('nav-my-drive-tree');
        if (tree) {
            tree.innerHTML = '';
            tree.classList.add('hidden');
        }
        clearActiveFolders();
    }

    function init() {
        if (!API.isLoggedIn()) return;
        loadExpandedState();
        updateRootChevron();

        const chevron = document.getElementById('nav-my-drive-chevron');
        if (chevron && !chevron.dataset.bound) {
            chevron.dataset.bound = '1';
            chevron.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                await toggleExpand(null);
            });
        }
    }

    return {
        init,
        syncWithRoute,
        refresh,
        invalidateAll,
    };
})();
