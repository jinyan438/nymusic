// 内置浏览器模块
const InAppBrowser = {
    // 电脑UA
    desktopUA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    
    // 打开内置浏览器
    open(url) {
        // 创建浏览器容器
        const container = document.createElement('div');
        container.id = 'inapp-browser';
        container.innerHTML = `
            <div class="browser-header">
                <button class="browser-close-btn"><i class="fas fa-times"></i></button>
                <span class="browser-title">加载中...</span>
                <button class="browser-refresh-btn"><i class="fas fa-redo"></i></button>
            </div>
            <iframe class="browser-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
        `;
        document.body.appendChild(container);
        
        const iframe = container.querySelector('.browser-frame');
        const titleEl = container.querySelector('.browser-title');
        const closeBtn = container.querySelector('.browser-close-btn');
        const refreshBtn = container.querySelector('.browser-refresh-btn');
        
        // 加载URL
        iframe.src = url;
        
        // 尝试获取标题
        iframe.onload = () => {
            try {
                titleEl.textContent = iframe.contentDocument?.title || new URL(url).hostname;
            } catch (e) {
                titleEl.textContent = new URL(url).hostname;
            }
        };
        
        // 关闭按钮
        closeBtn.onclick = () => container.remove();
        
        // 刷新按钮
        refreshBtn.onclick = () => {
            iframe.src = iframe.src;
            titleEl.textContent = '加载中...';
        };
        
        // 显示动画
        requestAnimationFrame(() => container.classList.add('show'));
    }
};

// 绑定歌单链接点击事件
function initPlaylistLinks() {
    document.querySelectorAll('.playlist-link-item a').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            InAppBrowser.open(link.href);
        });
    });
}

// DOM加载后初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPlaylistLinks);
} else {
    initPlaylistLinks();
}
