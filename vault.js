/**
 * Link Hub — الخزينة السرية (Secret Vault)
 * تشفير وحفظ مفاتيح API، رموز GitHub، معرفات Google، والبيانات الحساسة.
 * 
 * الأمان:
 *  - تشفير طرفي معزول (Zero-Knowledge) في المتصفح.
 *  - خوارزمية الاشتقاق: PBKDF2 (100,000 تكرار مع SHA-256 ومِلح عشوائي 16 بايت).
 *  - خوارزمية التشفير: AES-GCM (256-bit) مع مُتّجه تهيئة عشوائي (IV 12-byte) لكل تشفير.
 *  - لا تُخزن كلمة المرور أبداً: يتم التحقق بمحاولة فك تشفير رمز تحقق تجريبي.
 */
(function (root) {
    'use strict';

    const VAULT_STORE_KEY = 'lh_vault_v1';
    const CHECK_PHRASE = 'LINK_HUB_VAULT_OK';
    const PBKDF2_ITERATIONS = 100000;

    // حالة الخزينة في الذاكرة أثناء الجلسة
    let sessionKey = null;          // CryptoKey بعد فك القفل
    let decryptedItems = null;      // مصفوفة المفاتيح بعد فك التشفير
    let vaultSearchQuery = '';
    let autoLockTimer = null;
    const AUTO_LOCK_MINUTES = 15;   // قفل تلقائي بعد 15 دقيقة من عدم النشاط

    /* ------------------------------------------------------------------ */
    /*  أدوات التشفير والتحويل (Web Crypto API)                           */
    /* ------------------------------------------------------------------ */
    const cryptoSubtle = window.crypto && window.crypto.subtle;

    function buf2b64(buffer) {
        let binary = '';
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }

    function b642buf(b64) {
        const binary = window.atob(b64);
        const len = binary.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }

    function getRandomBytes(len) {
        const arr = new Uint8Array(len);
        window.crypto.getRandomValues(arr);
        return arr;
    }

    async function deriveKey(password, saltBuffer) {
        const enc = new TextEncoder();
        const passKey = await cryptoSubtle.importKey(
            'raw',
            enc.encode(password),
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );
        return cryptoSubtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: saltBuffer,
                iterations: PBKDF2_ITERATIONS,
                hash: 'SHA-256'
            },
            passKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    async function encryptString(text, key, iv) {
        const enc = new TextEncoder();
        const encoded = enc.encode(text);
        const cipher = await cryptoSubtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            encoded
        );
        return buf2b64(cipher);
    }

    async function decryptString(cipherB64, key, iv) {
        const cipherBuf = b642buf(cipherB64);
        const decrypted = await cryptoSubtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            cipherBuf
        );
        const dec = new TextDecoder();
        return dec.decode(decrypted);
    }

    /* ------------------------------------------------------------------ */
    /*  التخزين وإدارة الخزينة                                             */
    /* ------------------------------------------------------------------ */
    function getStoredRaw() {
        try {
            const raw = localStorage.getItem(VAULT_STORE_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function saveStoredRaw(data) {
        try {
            localStorage.setItem(VAULT_STORE_KEY, JSON.stringify(data));
            // جدولة المزامنة السحابية إن وُجدت
            if (root.LinkSync && typeof root.LinkSync.schedule === 'function') {
                root.LinkSync.schedule();
            }
            return true;
        } catch (e) {
            console.error('فشل حفظ بيانات الخزينة في localStorage', e);
            return false;
        }
    }

    function resetAutoLock() {
        if (autoLockTimer) clearTimeout(autoLockTimer);
        if (sessionKey) {
            autoLockTimer = setTimeout(() => {
                lock();
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم قفل الخزينة تلقائياً للأمان', 'info');
                }
            }, AUTO_LOCK_MINUTES * 60 * 1000);
        }
    }

    /* ------------------------------------------------------------------ */
    /*  الوظائف الأساسية                                                  */
    /* ------------------------------------------------------------------ */
    const LinkVault = {
        hasPassword() {
            const s = getStoredRaw();
            return !!(s && s.salt && s.check);
        },

        isUnlocked() {
            return !!(sessionKey && decryptedItems);
        },

        async setupPassword(password) {
            if (!password || password.length < 4) {
                throw new Error('يجب أن لا تقل كلمة المرور عن 4 أحرف أو أرقام');
            }
            const salt = getRandomBytes(16);
            const key = await deriveKey(password, salt);
            const iv = getRandomBytes(12);
            const check = await encryptString(CHECK_PHRASE, key, iv);
            const dataIv = getRandomBytes(12);
            const encData = await encryptString(JSON.stringify([]), key, dataIv);

            const record = {
                v: 1,
                salt: buf2b64(salt),
                checkIv: buf2b64(iv),
                check,
                dataIv: buf2b64(dataIv),
                data: encData,
                u: Date.now()
            };

            if (!saveStoredRaw(record)) {
                throw new Error('تعذّر الحفظ في مساحة التخزين');
            }

            sessionKey = key;
            decryptedItems = [];
            resetAutoLock();
            this.updateIconState();
            return true;
        },

        async unlock(password) {
            const s = getStoredRaw();
            if (!s || !s.salt || !s.check) {
                throw new Error('لم يتم تعيين كلمة مرور للخزينة بعد');
            }

            const saltBuf = b642buf(s.salt);
            const key = await deriveKey(password, saltBuf);
            const checkIv = b642buf(s.checkIv);

            let checkDecrypted = '';
            try {
                checkDecrypted = await decryptString(s.check, key, checkIv);
            } catch (err) {
                throw new Error('كلمة المرور غير صحيحة');
            }

            if (checkDecrypted !== CHECK_PHRASE) {
                throw new Error('كلمة المرور غير صحيحة');
            }

            // فك تشفير قائمة العناصر
            let items = [];
            if (s.data && s.dataIv) {
                try {
                    const dataIv = b642buf(s.dataIv);
                    const jsonStr = await decryptString(s.data, key, dataIv);
                    items = JSON.parse(jsonStr);
                    if (!Array.isArray(items)) items = [];
                } catch (e) {
                    items = [];
                }
            }

            sessionKey = key;
            decryptedItems = items;
            resetAutoLock();
            this.updateIconState();
            return items;
        },

        lock() {
            sessionKey = null;
            decryptedItems = null;
            if (autoLockTimer) clearTimeout(autoLockTimer);
            this.updateIconState();
            this.closeAllModals();
        },

        async saveItems() {
            if (!this.isUnlocked()) return false;
            const s = getStoredRaw() || {};
            const dataIv = getRandomBytes(12);
            const encData = await encryptString(JSON.stringify(decryptedItems), sessionKey, dataIv);

            s.dataIv = buf2b64(dataIv);
            s.data = encData;
            s.u = Date.now();

            const ok = saveStoredRaw(s);
            resetAutoLock();
            return ok;
        },

        async addOrUpdateItem(item) {
            if (!this.isUnlocked()) throw new Error('الخزينة مقفلة');
            if (!item.name || !item.name.trim()) throw new Error('اسم المفتاح مطلوب');
            if (!item.value || !item.value.trim()) throw new Error('قيمة المفتاح مطلوبة');

            const now = Date.now();
            if (item.id) {
                const idx = decryptedItems.findIndex(x => x.id === item.id);
                if (idx !== -1) {
                    decryptedItems[idx] = {
                        ...decryptedItems[idx],
                        name: item.name.trim(),
                        type: item.type || 'api_key',
                        value: item.value.trim(),
                        notes: (item.notes || '').trim(),
                        u: now
                    };
                }
            } else {
                decryptedItems.unshift({
                    id: 'sec-' + now.toString(36) + Math.random().toString(36).slice(2, 6),
                    name: item.name.trim(),
                    type: item.type || 'api_key',
                    value: item.value.trim(),
                    notes: (item.notes || '').trim(),
                    createdAt: now,
                    u: now
                });
            }

            await this.saveItems();
            this.renderVaultList();
        },

        async deleteItem(id) {
            if (!this.isUnlocked()) return;
            decryptedItems = decryptedItems.filter(x => x.id !== id);
            await this.saveItems();
            this.renderVaultList();
        },

        async changePassword(oldPassword, newPassword) {
            if (!newPassword || newPassword.length < 4) {
                throw new Error('كلمة المرور الجديدة يجب أن لا تقل عن 4 أحرف أو أرقام');
            }
            // تحقق من القديمة
            await this.unlock(oldPassword);
            // اشتقاق مفتاح جديد بملح جديد
            const salt = getRandomBytes(16);
            const newKey = await deriveKey(newPassword, salt);
            const checkIv = getRandomBytes(12);
            const check = await encryptString(CHECK_PHRASE, newKey, checkIv);
            const dataIv = getRandomBytes(12);
            const encData = await encryptString(JSON.stringify(decryptedItems), newKey, dataIv);

            const record = {
                v: 1,
                salt: buf2b64(salt),
                checkIv: buf2b64(checkIv),
                check,
                dataIv: buf2b64(dataIv),
                data: encData,
                u: Date.now()
            };

            saveStoredRaw(record);
            sessionKey = newKey;
            resetAutoLock();
            return true;
        },

        // دعم المزامنة والنسخ الاحتياطي
        getRawEncrypted() {
            return getStoredRaw();
        },

        setRawEncrypted(raw) {
            if (raw && raw.salt && raw.check && raw.data) {
                const cur = getStoredRaw();
                // دمج بناءً على طابع الوقت الأحدث
                if (!cur || (raw.u && raw.u > (cur.u || 0))) {
                    saveStoredRaw(raw);
                    // إذا كانت مفتوحة وتغيرت، نقفلها لإعادة الفتح بالأمان
                    if (sessionKey) this.lock();
                }
            }
        },

        /* ------------------------------------------------------------------ */
        /*  الواجهة التفاعلية (UI)                                            */
        /* ------------------------------------------------------------------ */
        init() {
            this.cacheElements();
            this.bindEvents();
            this.updateIconState();
        },

        cacheElements() {
            this.el = {
                vaultBtn: document.getElementById('vaultBtn'),
                authModal: document.getElementById('vaultAuthModal'),
                authForm: document.getElementById('vaultAuthForm'),
                authTitle: document.getElementById('vaultAuthTitle'),
                authDesc: document.getElementById('vaultAuthDesc'),
                authPass: document.getElementById('vaultAuthPass'),
                authPassConfirm: document.getElementById('vaultAuthPassConfirm'),
                authConfirmWrap: document.getElementById('vaultAuthConfirmWrap'),
                authErr: document.getElementById('vaultAuthErr'),

                vaultModal: document.getElementById('vaultModal'),
                vaultList: document.getElementById('vaultList'),
                vaultSearch: document.getElementById('vaultSearch'),
                vaultCount: document.getElementById('vaultCount'),

                itemModal: document.getElementById('vaultItemModal'),
                itemForm: document.getElementById('vaultItemForm'),
                itemTitle: document.getElementById('vaultItemTitle'),
                itemId: document.getElementById('vaultItemId'),
                itemName: document.getElementById('vaultItemName'),
                itemType: document.getElementById('vaultItemType'),
                itemVal: document.getElementById('vaultItemVal'),
                itemNotes: document.getElementById('vaultItemNotes'),
                itemValToggle: document.getElementById('vaultItemValToggle'),

                changePassModal: document.getElementById('vaultChangePassModal'),
                changePassForm: document.getElementById('vaultChangePassForm'),
                changeOldPass: document.getElementById('vaultChangeOldPass'),
                changeNewPass: document.getElementById('vaultChangeNewPass'),
                changePassErr: document.getElementById('vaultChangePassErr')
            };
        },

        bindEvents() {
            if (this.el.vaultBtn) {
                this.el.vaultBtn.addEventListener('click', () => this.open());
            }

            // نموذج الدخول / الإعداد
            if (this.el.authForm) {
                this.el.authForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    this.handleAuthSubmit();
                });
            }

            // نموذج إضافة / تعديل عنصر
            if (this.el.itemForm) {
                this.el.itemForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    this.handleItemSubmit();
                });
            }

            // زر إظهار/إخفاء القيمة في نموذج الإدخال
            if (this.el.itemValToggle) {
                this.el.itemValToggle.addEventListener('click', () => {
                    const isPass = this.el.itemVal.type === 'password';
                    this.el.itemVal.type = isPass ? 'text' : 'password';
                    this.el.itemValToggle.setAttribute('aria-label', isPass ? 'إخفاء القيمة' : 'إظهار القيمة');
                    const use = this.el.itemValToggle.querySelector('use');
                    if (use) use.setAttribute('href', isPass ? '#i-eye-off' : '#i-eye');
                });
            }

            // البحث داخل الخزينة
            if (this.el.vaultSearch) {
                this.el.vaultSearch.addEventListener('input', (e) => {
                    vaultSearchQuery = (e.target.value || '').trim().toLowerCase();
                    this.renderVaultList();
                });
            }

            // تغيير كلمة المرور
            if (this.el.changePassForm) {
                this.el.changePassForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    this.handleChangePassSubmit();
                });
            }

            // إغلاق النوافذ عند النقر على الخلفية أو أزرار data-close
            document.querySelectorAll('#vaultAuthModal, #vaultModal, #vaultItemModal, #vaultChangePassModal').forEach(backdrop => {
                backdrop.addEventListener('click', (e) => {
                    if (e.target === backdrop || e.target.closest('[data-close]')) {
                        this.hideBackdrop(backdrop);
                    }
                });
            });

            // تفويض أحداث أزرار الخزينة داخل القائمة
            if (this.el.vaultList) {
                this.el.vaultList.addEventListener('click', (e) => {
                    const copyBtn = e.target.closest('[data-vault-copy]');
                    if (copyBtn) {
                        const val = copyBtn.dataset.vaultCopy;
                        this.copySecret(val);
                        return;
                    }

                    const revealBtn = e.target.closest('[data-vault-reveal]');
                    if (revealBtn) {
                        const card = revealBtn.closest('.vault-card');
                        const secretSpan = card.querySelector('.secret-text');
                        const isMasked = secretSpan.dataset.masked === '1';
                        if (isMasked) {
                            secretSpan.textContent = secretSpan.dataset.real;
                            secretSpan.dataset.masked = '0';
                            revealBtn.querySelector('use').setAttribute('href', '#i-eye-off');
                            revealBtn.setAttribute('aria-label', 'إخفاء القيمة');
                        } else {
                            secretSpan.textContent = '••••••••••••••••';
                            secretSpan.dataset.masked = '1';
                            revealBtn.querySelector('use').setAttribute('href', '#i-eye');
                            revealBtn.setAttribute('aria-label', 'إظهار القيمة');
                        }
                        return;
                    }

                    const editBtn = e.target.closest('[data-vault-edit]');
                    if (editBtn) {
                        const id = editBtn.dataset.vaultEdit;
                        this.openEditItem(id);
                        return;
                    }

                    const delBtn = e.target.closest('[data-vault-del]');
                    if (delBtn) {
                        const id = delBtn.dataset.vaultDel;
                        this.confirmDeleteItem(id);
                        return;
                    }
                });
            }

            // أحداث أزرار رأس نافذة الخزينة
            const addBtn = document.getElementById('vaultAddNewBtn');
            if (addBtn) addBtn.addEventListener('click', () => this.openAddItem());

            const lockBtn = document.getElementById('vaultLockNowBtn');
            if (lockBtn) lockBtn.addEventListener('click', () => {
                this.lock();
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم قفل الخزينة بنجاح', 'ok');
                }
            });

            const changeBtn = document.getElementById('vaultChangePassBtn');
            if (changeBtn) changeBtn.addEventListener('click', () => this.openChangePassModal());
        },

        updateIconState() {
            if (!this.el.vaultBtn) return;
            const use = this.el.vaultBtn.querySelector('use');
            if (!use) return;
            if (this.isUnlocked()) {
                use.setAttribute('href', '#i-unlock');
                this.el.vaultBtn.classList.add('vault-unlocked');
                this.el.vaultBtn.setAttribute('aria-label', 'الخزينة السرية (مفتوحة)');
            } else {
                use.setAttribute('href', '#i-key');
                this.el.vaultBtn.classList.remove('vault-unlocked');
                this.el.vaultBtn.setAttribute('aria-label', 'الخزينة السرية (مقفلة)');
            }
        },

        open() {
            resetAutoLock();
            if (this.isUnlocked()) {
                this.openVaultModal();
            } else {
                this.openAuthModal();
            }
        },

        openAuthModal() {
            const hasPass = this.hasPassword();
            this.el.authTitle.textContent = hasPass ? 'فتح الخزينة السرية' : 'إعداد كلمة مرور للخزينة';
            this.el.authDesc.textContent = hasPass
                ? 'أدخل كلمة المرور لفك تشفير مفاتيح API والرموز السرية.'
                : 'أنشئ كلمة مرور قوية لتشفير مفاتيحك. هذه الكلمة لا تُحفظ في أي مكان ولن يمكن استرجاع المفاتيح بدونها.';
            this.el.authConfirmWrap.hidden = hasPass;
            this.el.authPass.value = '';
            this.el.authPassConfirm.value = '';
            this.el.authErr.hidden = true;
            this.showBackdrop(this.el.authModal);
            setTimeout(() => this.el.authPass.focus(), 100);
        },

        async handleAuthSubmit() {
            const hasPass = this.hasPassword();
            const pass = this.el.authPass.value;
            this.el.authErr.hidden = true;

            try {
                if (!hasPass) {
                    const confirmPass = this.el.authPassConfirm.value;
                    if (pass !== confirmPass) {
                        throw new Error('كلمتا المرور غير متطابقتين');
                    }
                    await this.setupPassword(pass);
                    this.hideBackdrop(this.el.authModal);
                    if (typeof root.LinkVaultToast === 'function') {
                        root.LinkVaultToast('تم إنشاء الخزينة بنجاح', 'ok');
                    }
                    this.openVaultModal();
                } else {
                    await this.unlock(pass);
                    this.hideBackdrop(this.el.authModal);
                    if (typeof root.LinkVaultToast === 'function') {
                        root.LinkVaultToast('تم فتح الخزينة', 'ok');
                    }
                    this.openVaultModal();
                }
            } catch (err) {
                this.el.authErr.textContent = err.message || 'حدث خطأ';
                this.el.authErr.hidden = false;
            }
        },

        openVaultModal() {
            this.renderVaultList();
            this.showBackdrop(this.el.vaultModal);
        },

        renderVaultList() {
            if (!this.el.vaultList) return;
            const items = decryptedItems || [];
            const query = vaultSearchQuery;

            const filtered = items.filter(it => {
                if (!query) return true;
                return (it.name && it.name.toLowerCase().includes(query)) ||
                    (it.type && it.type.toLowerCase().includes(query)) ||
                    (it.notes && it.notes.toLowerCase().includes(query));
            });

            if (this.el.vaultCount) {
                this.el.vaultCount.textContent = items.length === 1 ? 'مفتاح واحد' :
                    items.length === 2 ? 'مفتاحان' :
                    items.length <= 10 ? `${items.length} مفاتيح` : `${items.length} مفتاحاً`;
            }

            if (!filtered.length) {
                this.el.vaultList.innerHTML = `
                    <div class="empty-state" style="padding: 30px 10px; text-align: center; color: var(--muted);">
                        <svg class="ic" style="width:40px;height:40px;margin-bottom:10px;opacity:0.6;"><use href="#i-key"/></svg>
                        <p>${query ? 'لا توجد نتائج مطابقة للبحث' : 'الخزينة فارغة حالياً. اضغط "إضافة مفتاح" لحفظ مفاتيح API ورموزك بأمان.'}</p>
                    </div>`;
                return;
            }

            const typeLabels = {
                api_key: { label: 'API Key', cls: 'badge-api' },
                token: { label: 'GitHub / Token', cls: 'badge-token' },
                client_id: { label: 'Google / Client ID', cls: 'badge-client' },
                secret: { label: 'رمز سري / Secret', cls: 'badge-secret' },
                other: { label: 'آخر', cls: 'badge-other' }
            };

            this.el.vaultList.innerHTML = filtered.map(item => {
                const meta = typeLabels[item.type] || typeLabels.other;
                const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
                return `
                    <li class="vault-card" data-id="${esc(item.id)}">
                        <div class="vault-card-head">
                            <span class="vault-badge ${meta.cls}">${meta.label}</span>
                            <strong class="vault-card-title">${esc(item.name)}</strong>
                            <div class="vault-card-actions">
                                <button type="button" class="icon-btn sm" data-vault-edit="${esc(item.id)}" title="تعديل">
                                    <svg class="ic"><use href="#i-pencil"/></svg>
                                </button>
                                <button type="button" class="icon-btn sm danger" data-vault-del="${esc(item.id)}" title="حذف">
                                    <svg class="ic"><use href="#i-trash"/></svg>
                                </button>
                            </div>
                        </div>

                        <div class="secret-box">
                            <span class="secret-text" data-masked="1" data-real="${esc(item.value)}">••••••••••••••••</span>
                            <div class="secret-actions">
                                <button type="button" class="icon-btn sm" data-vault-reveal title="إظهار / إخفاء">
                                    <svg class="ic"><use href="#i-eye"/></svg>
                                </button>
                                <button type="button" class="btn sm primary-soft" data-vault-copy="${esc(item.value)}" title="نسخ إلى الحافظة">
                                    <svg class="ic"><use href="#i-copy"/></svg>
                                    <span>نسخ</span>
                                </button>
                            </div>
                        </div>

                        ${item.notes ? `<p class="vault-notes">${esc(item.notes)}</p>` : ''}
                    </li>
                `;
            }).join('');
        },

        openAddItem() {
            this.el.itemTitle.textContent = 'إضافة مفتاح / رمز جديد';
            this.el.itemId.value = '';
            this.el.itemName.value = '';
            this.el.itemType.value = 'api_key';
            this.el.itemVal.value = '';
            this.el.itemVal.type = 'password';
            this.el.itemNotes.value = '';
            if (this.el.itemValToggle) {
                const use = this.el.itemValToggle.querySelector('use');
                if (use) use.setAttribute('href', '#i-eye');
            }
            this.showBackdrop(this.el.itemModal);
            setTimeout(() => this.el.itemName.focus(), 100);
        },

        openEditItem(id) {
            const item = (decryptedItems || []).find(x => x.id === id);
            if (!item) return;

            this.el.itemTitle.textContent = 'تعديل المفتاح';
            this.el.itemId.value = item.id;
            this.el.itemName.value = item.name;
            this.el.itemType.value = item.type || 'api_key';
            this.el.itemVal.value = item.value;
            this.el.itemVal.type = 'password';
            this.el.itemNotes.value = item.notes || '';
            if (this.el.itemValToggle) {
                const use = this.el.itemValToggle.querySelector('use');
                if (use) use.setAttribute('href', '#i-eye');
            }
            this.showBackdrop(this.el.itemModal);
            setTimeout(() => this.el.itemName.focus(), 100);
        },

        async handleItemSubmit() {
            const item = {
                id: this.el.itemId.value || null,
                name: this.el.itemName.value,
                type: this.el.itemType.value,
                value: this.el.itemVal.value,
                notes: this.el.itemNotes.value
            };

            try {
                await this.addOrUpdateItem(item);
                this.hideBackdrop(this.el.itemModal);
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم حفظ المفتاح بأمان', 'ok');
                }
            } catch (err) {
                alert(err.message || 'حدث خطأ أثناء الحفظ');
            }
        },

        async confirmDeleteItem(id) {
            const item = (decryptedItems || []).find(x => x.id === id);
            if (!item) return;
            const ok = window.confirm(`هل أنت متأكد من حذف المفتاح "${item.name}"؟`);
            if (ok) {
                await this.deleteItem(id);
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم حذف المفتاح من الخزينة', 'ok');
                }
            }
        },

        openChangePassModal() {
            this.el.changeOldPass.value = '';
            this.el.changeNewPass.value = '';
            this.el.changePassErr.hidden = true;
            this.showBackdrop(this.el.changePassModal);
            setTimeout(() => this.el.changeOldPass.focus(), 100);
        },

        async handleChangePassSubmit() {
            const oldPass = this.el.changeOldPass.value;
            const newPass = this.el.changeNewPass.value;
            this.el.changePassErr.hidden = true;

            try {
                await this.changePassword(oldPass, newPass);
                this.hideBackdrop(this.el.changePassModal);
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم تغيير كلمة مرور الخزينة بنجاح', 'ok');
                }
            } catch (err) {
                this.el.changePassErr.textContent = err.message || 'حدث خطأ أثناء التغيير';
                this.el.changePassErr.hidden = false;
            }
        },

        async copySecret(val) {
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(val);
                } else {
                    const ta = document.createElement('textarea');
                    ta.value = val;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    ta.remove();
                }
                if (typeof root.LinkVaultToast === 'function') {
                    root.LinkVaultToast('تم نسخ القيمة إلى الحافظة', 'ok');
                }
            } catch (e) {
                alert('تعذر النسخ تلقائياً');
            }
        },

        showBackdrop(el) {
            if (!el) return;
            el.classList.add('open');
            el.setAttribute('aria-hidden', 'false');
            document.body.classList.add('no-scroll');
        },

        hideBackdrop(el) {
            if (!el) return;
            el.classList.remove('open');
            el.setAttribute('aria-hidden', 'true');
            if (!document.querySelector('.backdrop.open')) {
                document.body.classList.remove('no-scroll');
            }
        },

        closeAllModals() {
            [this.el.authModal, this.el.vaultModal, this.el.itemModal, this.el.changePassModal].forEach(m => {
                if (m) this.hideBackdrop(m);
            });
        }
    };

    // إتاحة الكائن عالمياً
    root.LinkVault = LinkVault;

    // تشغيل عند تحميل الصفحة
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => LinkVault.init());
    } else {
        LinkVault.init();
    }

})(window);
