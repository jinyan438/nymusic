const QQLogin = {
    generation: 0,
    timer: null,
    session: null,
    account: null,

    init() {
        DOM.qqLoginBtn.addEventListener('click', () => this.open());
        DOM.qqLoginClose.addEventListener('click', () => DOM.qqLoginDialog.close());
        DOM.qqLoginRefresh.addEventListener('click', () => this.refresh());
        DOM.qqLoginDialog.addEventListener('close', () => this.stop());
        DOM.qqLoginDialog.addEventListener('cancel', () => this.stop());
    },

    async load() {
        const saved = await IDB.getSetting('qqLogin', null);
        QQMusic.setCookie(saved?.cookie || await IDB.getSetting('qqCookie', ''));
        this.account = saved?.account || null;
        this.renderAccount();
    },

    renderAccount() {
        const loggedIn = !!QQMusic.cookie;
        const name = this.account?.nickname || (QQMusic.getUin() !== '0' ? QQMusic.getUin() : '已登录');
        DOM.qqAccountName.textContent = loggedIn ? name : '';
        DOM.qqAccountName.hidden = !loggedIn;
        DOM.qqLoginBtn.textContent = loggedIn ? '重新登录' : '扫码登录';
    },

    open() {
        if (!DOM.qqLoginDialog.open) DOM.qqLoginDialog.showModal();
        this.refresh();
    },

    stop() {
        this.generation++;
        clearTimeout(this.timer);
        this.timer = null;
        this.session?.cancel();
        this.session = null;
        DOM.qqLoginImage.removeAttribute('src');
        DOM.qqLoginImage.hidden = true;
    },

    async refresh() {
        this.stop();
        const generation = this.generation;
        const session = new QqLoginSession(undefined, { onProgress: stage => {
            if (!this.isActive(generation)) return;
            const messages = { signature: 'QQ 已确认，正在获取授权…', authorize: '正在获取音乐授权…', exchange: '正在登录 QQ 音乐…' };
            if (messages[stage]) DOM.qqLoginStatus.textContent = messages[stage];
        } });
        this.session = session;
        DOM.qqLoginStatus.textContent = '正在获取二维码…';
        DOM.qqLoginRefresh.disabled = true;
        DOM.qqLoginImage.classList.remove('expired');
        try {
            const qr = await session.start();
            if (!this.isActive(generation)) return;
            DOM.qqLoginImage.src = qr.image;
            DOM.qqLoginImage.hidden = false;
            DOM.qqLoginStatus.textContent = '使用手机 QQ 扫码登录';
            DOM.qqLoginRefresh.disabled = false;
            this.schedule(generation);
        } catch (_) {
            if (!this.isActive(generation)) return;
            DOM.qqLoginStatus.textContent = '获取二维码失败，请刷新重试';
            DOM.qqLoginRefresh.disabled = false;
        }
    },

    isActive(generation) { return generation === this.generation && DOM.qqLoginDialog.open; },

    schedule(generation, failures = 0) {
        if (this.isActive(generation)) this.timer = setTimeout(() => this.poll(generation, failures), 2000);
    },

    async poll(generation, failures = 0) {
        if (!this.isActive(generation)) return;
        this.timer = null;
        try {
            const result = await this.session.poll();
            if (!this.isActive(generation)) return;
            if (result.state === 'success') {
                DOM.qqLoginRefresh.disabled = true;
                DOM.qqLoginStatus.textContent = '正在保存登录状态…';
                const { cookie, ...account } = result.account;
                // 一条记录保存账号资料和凭证，避免写入一半的登录状态。
                await IDB.setSetting('qqLogin', { cookie, account });
                if (!this.isActive(generation)) return;
                QQMusic.setCookie(cookie);
                this.account = account;
                this.renderAccount();
                DOM.qqLoginDialog.close();
                this.stop();
                return;
            }
            if (result.state === 'expired' || result.state === 'cancelled') {
                DOM.qqLoginStatus.textContent = result.state === 'expired' ? '二维码已过期，请刷新' : '已取消登录，请刷新二维码';
                DOM.qqLoginImage.classList.add('expired');
                return;
            }
            DOM.qqLoginStatus.textContent = result.state === 'scanned' ? '已扫码，请在手机 QQ 确认' : '使用手机 QQ 扫码登录';
            this.schedule(generation);
        } catch (error) {
            if (!this.isActive(generation)) return;
            if (failures < 2 && !this.session.authenticated && !this.session.authorizationFailed) {
                DOM.qqLoginStatus.textContent = '连接中断，正在重试…';
                this.schedule(generation, failures + 1);
            } else {
                const reason = error?.name === 'QqLoginError' ? error.userMessage : '';
                DOM.qqLoginStatus.textContent = this.session.authenticated ? '保存登录状态失败，请重新扫码' : reason || '登录失败，请刷新二维码重试';
                DOM.qqLoginRefresh.disabled = false;
            }
        }
    }
};
