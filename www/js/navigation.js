// 页面导航
function showPage(pageId) {
    DOM.pages.forEach(page => page.classList.toggle('active', page.id === pageId));
    DOM.navItems.forEach(item => item.classList.toggle('active', item.dataset.page === pageId));
}

function initNavigation() {
    DOM.navItems.forEach(item => item.addEventListener('click', () => showPage(item.dataset.page)));
    
    // 排行榜页面切换时自动加载
    DOM.navItems.forEach(item => {
        item.addEventListener('click', () => {
            if (item.dataset.page === 'toplist-page' && DOM.toplistCategories.innerHTML === '') {
                loadToplists();
            }
        });
    });
}
