// 工具函数
function formatTime(seconds) {
    const min = Math.floor(seconds / 60).toString().padStart(2, '0');
    const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${min}:${sec}`;
}

// 标准化榜单名称用于匹配
function normalizeToplistName(name) {
    return name.replace(/榜$/, '').replace(/排行$/, '').replace(/TOP\d+/i, '').trim();
}

// 快速点击处理 - 直接使用click，禁用长按菜单
function addFastClick(element, callback) {
    // 禁用长按上下文菜单
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    // 直接使用click事件
    element.addEventListener('click', callback);
}
