// Tab Switching Logic
function switchTab(tabId) {
    document.querySelectorAll('.sheet-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.querySelector(`.sheet-tab[data-tab="${tabId}"]`).classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

// Set Current Date for Live Stock
document.getElementById('current-date-display').textContent = "As on " + new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: '2-digit', year: 'numeric'
}).replace(/\//g, '-');

// Application State (Defaulting to Demo Data)
let masterData = [
    { "Product Code": 'PC-1-PAC-I', "Product Description": 'Poly Cover', "MOQ / ROL": 300, "UOM": 'Kgs' },
    { "Product Code": 'PC-2-PAC-I', "Product Description": 'Poly Cover', "MOQ / ROL": 500, "UOM": 'Kgs' },
    { "Product Code": 'PC-3-PAC-I', "Product Description": 'Poly Cover', "MOQ / ROL": 500, "UOM": 'Kgs' },
    { "Product Code": 'PC-4-PAC-I', "Product Description": 'Ziplock Cover', "MOQ / ROL": 500, "UOM": 'Kgs' }
];

let inwardData = [
    { "Date": '20-05-2026', "DC No / Inv No": '', "Part Code": 'PC-1-PAC-I', "Quantity": 10000, "Location": '', "Remarks": '' },
    { "Date": '01-06-2026', "DC No / Inv No": '', "Part Code": 'PC-2-PAC-I', "Quantity": 10000, "Location": '', "Remarks": '' }
];

let outwardData = [
    { "Date": '02-06-2026', "Invoice No": '', "DC No": '', "Product Code": 'PC-1-PAC-I', "Quantity": 9500, "Delivery Location": '', "Approved By": '', "Remarks": '' }
];

const GOOGLE_SHEETS_WEBAPP_URL = '';

const LOCAL_STATE_KEY = 'bw_stock_system_state_v1';

const googleSyncState = {
    pendingTimer: null,
    lastSyncAt: null,
    inFlight: false
};

const localDbState = {
    fileHandle: null,
    pendingTimer: null,
    inFlight: false
};

const tableFilters = {
    inward: { from: null, to: null },
    outward: { from: null, to: null }
};

function loadLocalState() {
    try {
        const raw = window.localStorage.getItem(LOCAL_STATE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.masterData)) masterData = parsed.masterData;
            if (Array.isArray(parsed.inwardData)) inwardData = parsed.inwardData;
            if (Array.isArray(parsed.outwardData)) outwardData = parsed.outwardData;
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

function saveLocalState() {
    try {
        window.localStorage.setItem(
            LOCAL_STATE_KEY,
            JSON.stringify({ masterData, inwardData, outwardData })
        );
    } catch {
    }
}

function setRibbonStatus(text, color) {
    const el = document.getElementById('db-status');
    if (!el) return;
    el.textContent = text;
    if (color) el.style.color = color;
}

function isGoogleSyncEnabled() {
    return typeof GOOGLE_SHEETS_WEBAPP_URL === 'string' && GOOGLE_SHEETS_WEBAPP_URL.trim().length > 0;
}

async function postJson(url, payload) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const text = await response.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = { ok: false, error: 'Invalid JSON response', raw: text };
    }
    if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}`, details: json };
    }
    return json;
}

function supportsLocalFileAutoSave() {
    return typeof window.showOpenFilePicker === 'function';
}

function toDdMmYyyy(date) {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    return `${dd}-${mm}-${yyyy}`;
}

function firstNonEmptyValue(obj, keys) {
    if (!obj || typeof obj !== 'object') return '';
    for (let i = 0; i < keys.length; i += 1) {
        const k = keys[i];
        const v = obj[k];
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (s.length > 0) return s;
    }
    return '';
}

function normalizeCode(value) {
    return String(value || '').trim();
}

function masterCode(row) {
    return normalizeCode(firstNonEmptyValue(row, ['Product Code', 'Part Code', 'PartCode', 'Code', 'Item Code']));
}

function masterDesc(row) {
    return firstNonEmptyValue(row, ['Product Description', 'Description', 'Part Description', 'Item Description']);
}

function masterUom(row) {
    return firstNonEmptyValue(row, ['UOM', 'UoM', 'Unit', 'Units']);
}

function masterMoq(row) {
    const raw = firstNonEmptyValue(row, ['MOQ / ROL', 'MOQ', 'ROL', 'Min Qty', 'Minimum']);
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
}

function inwardCode(row) {
    return normalizeCode(firstNonEmptyValue(row, ['Part Code', 'Product Code', 'PartCode', 'Code', 'Item Code']));
}

function inwardQty(row) {
    const raw = firstNonEmptyValue(row, ['Quantity', 'Qty']);
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
}

function outwardCode(row) {
    return normalizeCode(firstNonEmptyValue(row, ['Product Code', 'Part Code', 'PartCode', 'Code', 'Item Code']));
}

function outwardQty(row) {
    const raw = firstNonEmptyValue(row, ['Quantity', 'Qty']);
    const n = Number(raw || 0);
    return Number.isFinite(n) ? n : 0;
}

function parseDdMmYyyy(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (!match) return null;
    const dd = Number(match[1]);
    const mm = Number(match[2]);
    const yyyy = Number(match[3]);
    if (!yyyy || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
    const dt = new Date(yyyy, mm - 1, dd);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function parseYyyyMmDd(value) {
    const raw = String(value || '').trim();
    const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const yyyy = Number(match[1]);
    const mm = Number(match[2]);
    const dd = Number(match[3]);
    const dt = new Date(yyyy, mm - 1, dd);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
}

function clampDateToStartOfDay(date) {
    if (!date) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isDateInRange(date, from, to) {
    if (!date) return false;
    const t = clampDateToStartOfDay(date).getTime();
    const f = from ? clampDateToStartOfDay(from).getTime() : null;
    const e = to ? clampDateToStartOfDay(to).getTime() : null;
    if (f !== null && t < f) return false;
    if (e !== null && t > e) return false;
    return true;
}

function canDeleteRowByPolicy(row) {
    if (!row || typeof row !== 'object') return false;
    if (typeof row._createdAt !== 'number') return false;
    const now = Date.now();
    if (now - row._createdAt > 24 * 60 * 60 * 1000) return false;
    const today = toDdMmYyyy(new Date());
    const rowDate = String(row["Date"] || '').trim();
    return rowDate === today;
}

function makeId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function openIdb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('bw_stock_system', 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function idbGet(key) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
    });
}

async function idbSet(key, value) {
    const db = await openIdb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
    });
}

async function loadFromLocalDbHandle(handle) {
    const file = await handle.getFile();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    if (workbook.Sheets['Master']) masterData = XLSX.utils.sheet_to_json(workbook.Sheets['Master']);
    if (workbook.Sheets['Stock Inward']) inwardData = XLSX.utils.sheet_to_json(workbook.Sheets['Stock Inward']);
    if (workbook.Sheets['Stock Outward']) outwardData = XLSX.utils.sheet_to_json(workbook.Sheets['Stock Outward']);
}

function buildWorkbookFromState() {
    const wb = XLSX.utils.book_new();
    const cleanMaster = masterData
        .map((row) => ({
            "Product Code": masterCode(row),
            "Product Description": masterDesc(row),
            "MOQ / ROL": masterMoq(row),
            "UOM": masterUom(row)
        }))
        .filter((row) => row["Product Code"]);

    const cleanInward = inwardData.map((row) => ({
        "Date": String((row && row["Date"]) || '').trim(),
        "DC No / Inv No": String((row && row["DC No / Inv No"]) || '').trim(),
        "Part Code": inwardCode(row),
        "Quantity": inwardQty(row),
        "Location": String((row && row["Location"]) || '').trim(),
        "Remarks": String((row && row["Remarks"]) || '').trim()
    }));

    const cleanOutward = outwardData.map((row) => ({
        "Date": String((row && row["Date"]) || '').trim(),
        "Invoice No": String((row && row["Invoice No"]) || '').trim(),
        "DC No": String((row && row["DC No"]) || '').trim(),
        "Product Code": outwardCode(row),
        "Quantity": outwardQty(row),
        "Delivery Location": String((row && row["Delivery Location"]) || '').trim(),
        "Approved By": String((row && row["Approved By"]) || '').trim(),
        "Remarks": String((row && row["Remarks"]) || '').trim()
    }));

    const wsMaster = XLSX.utils.json_to_sheet(cleanMaster);
    XLSX.utils.book_append_sheet(wb, wsMaster, "Master");

    const wsInward = XLSX.utils.json_to_sheet(cleanInward);
    XLSX.utils.book_append_sheet(wb, wsInward, "Stock Inward");

    const wsOutward = XLSX.utils.json_to_sheet(cleanOutward);
    XLSX.utils.book_append_sheet(wb, wsOutward, "Stock Outward");

    return wb;
}

async function openLocalDbWithAutoSave() {
    if (!supportsLocalFileAutoSave()) {
        setRibbonStatus('Auto-save needs Chrome/Edge. Use Save Database to download.', '#a80000');
        return;
    }

    const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
            {
                description: 'Excel Files',
                accept: {
                    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
                    'application/vnd.ms-excel': ['.xls']
                }
            }
        ]
    });

    if (!handle) return;
    await loadFromLocalDbHandle(handle);

    localDbState.fileHandle = handle;
    refreshAllTables();
    saveLocalState();
    try {
        await idbSet('localDbHandle', handle);
    } catch {
    }
    setRibbonStatus('Local DB opened (auto-save ON)', '#107c41');
}

async function saveToLocalDb() {
    if (!localDbState.fileHandle) return;
    if (localDbState.inFlight) return;

    localDbState.inFlight = true;
    setRibbonStatus('Auto-saving to local Excel…', '#605e5c');

    try {
        const wb = buildWorkbookFromState();
        const array = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        const writable = await localDbState.fileHandle.createWritable();
        await writable.write(array);
        await writable.close();
        setRibbonStatus('Auto-saved to local Excel', '#107c41');
    } catch {
        setRibbonStatus('Auto-save failed. Use Save Database to download.', '#a80000');
    } finally {
        localDbState.inFlight = false;
    }
}

function scheduleLocalAutoSave() {
    if (!localDbState.fileHandle) return;
    if (localDbState.pendingTimer) window.clearTimeout(localDbState.pendingTimer);
    localDbState.pendingTimer = window.setTimeout(() => {
        saveToLocalDb();
    }, 600);
}

async function tryRestoreLocalDbAutoSave() {
    if (!supportsLocalFileAutoSave()) return false;
    let handle = null;
    try {
        handle = await idbGet('localDbHandle');
    } catch {
        handle = null;
    }
    if (!handle) return false;

    try {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm !== 'granted') return false;

        await loadFromLocalDbHandle(handle);
        localDbState.fileHandle = handle;
        saveLocalState();
        return true;
    } catch {
        return false;
    }
}

async function loadFromGoogleSheet() {
    if (!isGoogleSyncEnabled()) return false;
    setRibbonStatus('Connecting to Google Sheet…', '#605e5c');
    const result = await postJson(GOOGLE_SHEETS_WEBAPP_URL, { action: 'getAll' });
    if (!result || result.ok === false) {
        setRibbonStatus('Google Sheet connect failed. Using local data.', '#a80000');
        return false;
    }

    masterData = Array.isArray(result.masterData) ? result.masterData : masterData;
    inwardData = Array.isArray(result.inwardData) ? result.inwardData : inwardData;
    outwardData = Array.isArray(result.outwardData) ? result.outwardData : outwardData;

    setRibbonStatus('Connected to Google Sheet (auto-save ON)', '#107c41');
    return true;
}

async function pushToGoogleSheet(reason) {
    if (!isGoogleSyncEnabled()) return;
    if (googleSyncState.inFlight) return;

    googleSyncState.inFlight = true;
    setRibbonStatus('Saving to Google Sheet…', '#605e5c');
    const result = await postJson(GOOGLE_SHEETS_WEBAPP_URL, {
        action: 'syncAll',
        reason,
        masterData,
        inwardData,
        outwardData
    });
    googleSyncState.inFlight = false;

    if (!result || result.ok === false) {
        setRibbonStatus('Google Sheet save failed. Data kept locally.', '#a80000');
        return;
    }

    googleSyncState.lastSyncAt = new Date();
    setRibbonStatus('Saved to Google Sheet', '#107c41');
}

function scheduleGoogleAutoSave(reason) {
    if (!isGoogleSyncEnabled()) return;
    if (googleSyncState.pendingTimer) window.clearTimeout(googleSyncState.pendingTimer);
    googleSyncState.pendingTimer = window.setTimeout(() => {
        pushToGoogleSheet(reason);
    }, 800);
}

// Logic to calculate live stock based on Inward and Outward
function calculateLiveStock() {
    const stockMap = new Map();

    masterData.forEach((row) => {
        const code = masterCode(row);
        if (!code) return;
        const key = code.toUpperCase();
        const existing = stockMap.get(key);
        const next = {
            code,
            desc: masterDesc(row),
            uom: masterUom(row),
            moq: masterMoq(row),
            available: existing ? existing.available : 0
        };
        if (!existing) stockMap.set(key, next);
        else stockMap.set(key, next);
    });

    inwardData.forEach((row) => {
        const code = inwardCode(row);
        if (!code) return;
        const key = code.toUpperCase();
        const item = stockMap.get(key);
        if (!item) return;
        item.available += inwardQty(row);
    });

    outwardData.forEach((row) => {
        const code = outwardCode(row);
        if (!code) return;
        const key = code.toUpperCase();
        const item = stockMap.get(key);
        if (!item) return;
        item.available -= outwardQty(row);
    });

    return Array.from(stockMap.values());
}

// Render Tables
function renderMasterTable() {
    const tbody = document.querySelector('#master-table tbody');
    tbody.innerHTML = masterData.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${masterCode(item) || ''}</td>
            <td>${masterDesc(item) || ''}</td>
            <td>${masterMoq(item) || 0}</td>
            <td>${masterUom(item) || ''}</td>
        </tr>
    `).join('');
}

function renderInwardTable() {
    const tbody = document.querySelector('#inward-table tbody');
    const filtered = inwardData.filter((row) => {
        if (!tableFilters.inward.from && !tableFilters.inward.to) return true;
        const d = parseDdMmYyyy(row && row["Date"]);
        return isDateInRange(d, tableFilters.inward.from, tableFilters.inward.to);
    });
    tbody.innerHTML = filtered.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${item["Date"] || ''}</td>
            <td>${item["DC No / Inv No"] || ''}</td>
            <td>${inwardCode(item) || ''}</td>
            <td class="qty-highlight">${inwardQty(item) || 0}</td>
            <td>${item["Location"] || ''}</td>
            <td>${item["Remarks"] || ''}</td>
            <td>
                <button class="btn-excel-danger" data-action="delete-inward" data-id="${item._id || ''}" ${canDeleteRowByPolicy(item) ? '' : 'disabled'}>
                    Delete
                </button>
            </td>
        </tr>
    `).join('');

    const countEl = document.getElementById('in-filter-count');
    if (countEl) {
        if (tableFilters.inward.from || tableFilters.inward.to) {
            countEl.textContent = `Showing ${filtered.length} of ${inwardData.length} entries`;
        } else {
            countEl.textContent = `Total ${inwardData.length} entries`;
        }
    }
}

function renderOutwardTable() {
    const tbody = document.querySelector('#outward-table tbody');
    const filtered = outwardData.filter((row) => {
        if (!tableFilters.outward.from && !tableFilters.outward.to) return true;
        const d = parseDdMmYyyy(row && row["Date"]);
        return isDateInRange(d, tableFilters.outward.from, tableFilters.outward.to);
    });
    tbody.innerHTML = filtered.map((item, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${item["Date"] || ''}</td>
            <td>${item["Invoice No"] || ''}</td>
            <td>${item["DC No"] || ''}</td>
            <td>${outwardCode(item) || ''}</td>
            <td>${outwardQty(item) || 0}</td>
            <td>${item["Delivery Location"] || ''}</td>
            <td>${item["Approved By"] || ''}</td>
            <td>${item["Remarks"] || ''}</td>
            <td>
                <button class="btn-excel-danger" data-action="delete-outward" data-id="${item._id || ''}" ${canDeleteRowByPolicy(item) ? '' : 'disabled'}>
                    Delete
                </button>
            </td>
        </tr>
    `).join('');

    const countEl = document.getElementById('out-filter-count');
    if (countEl) {
        if (tableFilters.outward.from || tableFilters.outward.to) {
            countEl.textContent = `Showing ${filtered.length} of ${outwardData.length} entries`;
        } else {
            countEl.textContent = `Total ${outwardData.length} entries`;
        }
    }
}

function renderLiveStockTable() {
    const liveStock = calculateLiveStock();
    const tbody = document.querySelector('#live-stock-table tbody');
    
    tbody.innerHTML = liveStock.map((item, index) => {
        const isRisk = item.available < item.moq;
        const riskText = isRisk ? 'Risk' : 'No Risk';
        const riskClass = isRisk ? 'risk-level-yes' : 'risk-level-no';

        return `
            <tr>
                <td>${index + 1}</td>
                <td>${item.code}</td>
                <td>${item.desc}</td>
                <td>${item.uom}</td>
                <td style="font-weight: 600;">${item.available}</td>
                <td>${item.moq}</td>
                <td class="${riskClass}">${riskText}</td>
            </tr>
        `;
    }).join('');

    const riskHeader = document.getElementById('risk-level-header');
    const titleHeader = document.getElementById('live-stock-title');
    if (riskHeader) {
        const hasRows = liveStock.length > 0;
        const allNoRisk = hasRows && liveStock.every((row) => Number(row.available) >= Number(row.moq));
        const anyRisk = hasRows && liveStock.some((row) => Number(row.available) < Number(row.moq));

        riskHeader.classList.remove('risk-level-no', 'risk-level-yes');
        if (allNoRisk) riskHeader.classList.add('risk-level-no');
        else if (anyRisk) riskHeader.classList.add('risk-level-yes');

        if (titleHeader) {
            titleHeader.classList.remove('red-theme', 'risk-header-no', 'risk-header-yes');
            if (allNoRisk) titleHeader.classList.add('risk-header-no');
            else if (anyRisk) titleHeader.classList.add('risk-header-yes');
            else titleHeader.classList.add('red-theme');
        }
    }
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function updateMasterCodesDatalist() {
    const datalist = document.getElementById('master-codes');
    if (!datalist) return;

    const codeToDesc = new Map();
    masterData.forEach((row) => {
        const code = masterCode(row);
        if (!code) return;
        const desc = masterDesc(row);
        if (!codeToDesc.has(code)) codeToDesc.set(code, desc);
    });

    const optionsHtml = Array.from(codeToDesc.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([code, desc]) => `<option value="${escapeHtml(code)}">${escapeHtml(desc)}</option>`)
        .join('');

    datalist.innerHTML = optionsHtml;
}

function hasMasterCode(code) {
    const normalized = normalizeCode(code).toUpperCase();
    if (!normalized) return false;
    return masterData.some((row) => masterCode(row).toUpperCase() === normalized);
}

function wireMasterOnlyInputs() {
    const inputIds = ['in-part', 'out-part'];
    inputIds.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', () => {
            const value = el.value;
            if (!value) {
                el.setCustomValidity('');
                return;
            }
            if (hasMasterCode(value)) {
                el.setCustomValidity('');
                return;
            }
            el.setCustomValidity('Product code must exist in Master');
        });
    });
}

function refreshAllTables() {
    renderMasterTable();
    renderInwardTable();
    renderOutwardTable();
    renderLiveStockTable();
    updateMasterCodesDatalist();
}

// --------------------------------------------------------
// FORM SUBMISSIONS
// --------------------------------------------------------
document.getElementById('inward-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const partCode = normalizeCode(document.getElementById('in-part').value);
    if (!hasMasterCode(partCode)) {
        alert('Part Code must exist in Master.');
        return;
    }
    inwardData.push({
        _id: makeId(),
        _createdAt: Date.now(),
        "Date": document.getElementById('in-date').value.split('-').reverse().join('-'),
        "DC No / Inv No": document.getElementById('in-dc').value,
        "Part Code": partCode,
        "Quantity": Number(document.getElementById('in-qty').value),
        "Location": document.getElementById('in-loc').value,
        "Remarks": document.getElementById('in-rem').value
    });
    this.reset();
    refreshAllTables();
    saveLocalState();
    scheduleGoogleAutoSave('inward:add');
    scheduleLocalAutoSave();
});

document.getElementById('outward-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const productCode = normalizeCode(document.getElementById('out-part').value);
    if (!hasMasterCode(productCode)) {
        alert('Product Code must exist in Master.');
        return;
    }
    outwardData.push({
        _id: makeId(),
        _createdAt: Date.now(),
        "Date": document.getElementById('out-date').value.split('-').reverse().join('-'),
        "Invoice No": document.getElementById('out-inv').value,
        "DC No": document.getElementById('out-dc').value,
        "Product Code": productCode,
        "Quantity": Number(document.getElementById('out-qty').value),
        "Delivery Location": document.getElementById('out-loc').value,
        "Approved By": document.getElementById('out-app').value,
        "Remarks": document.getElementById('out-rem').value
    });
    this.reset();
    refreshAllTables();
    saveLocalState();
    scheduleGoogleAutoSave('outward:add');
    scheduleLocalAutoSave();
});

document.getElementById('master-form').addEventListener('submit', function(e) {
    e.preventDefault();
    masterData.push({
        _id: makeId(),
        _createdAt: Date.now(),
        "Product Code": normalizeCode(document.getElementById('mast-code').value),
        "Product Description": document.getElementById('mast-desc').value,
        "MOQ / ROL": Number(document.getElementById('mast-moq').value),
        "UOM": document.getElementById('mast-uom').value
    });
    this.reset();
    refreshAllTables();
    saveLocalState();
    scheduleGoogleAutoSave('master:add');
    scheduleLocalAutoSave();
});

// --------------------------------------------------------
// EXCEL DATABASE LOGIC (SHEETJS)
// --------------------------------------------------------

// Load Excel File
document.getElementById('excel-upload').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });

        if (workbook.Sheets['Master']) {
            masterData = XLSX.utils.sheet_to_json(workbook.Sheets['Master']);
        }

        setRibbonStatus(`Imported Master: ${file.name}`, '#107c41');
        
        refreshAllTables();
        saveLocalState();
        scheduleGoogleAutoSave('excel:load');
    };
    reader.readAsArrayBuffer(file);
});

// Save Excel File
document.getElementById('download-db').addEventListener('click', function() {
    const wb = buildWorkbookFromState();
    XLSX.writeFile(wb, "stock.xlsx");
    saveLocalState();
    pushToGoogleSheet('excel:save');
});

// Download Template File (Based on Demo Data)
document.getElementById('template-db').addEventListener('click', function() {
    const wb = buildWorkbookFromState();
    XLSX.writeFile(wb, "BW_Stock_Template.xlsx");
});

function styleFill(rgb) {
    return { patternType: 'solid', fgColor: { rgb } };
}

function styleBorder() {
    const b = { style: 'thin', color: { rgb: 'D4D4D4' } };
    return { top: b, bottom: b, left: b, right: b };
}

function setCellStyle(ws, addr, style) {
    if (!ws[addr]) return;
    ws[addr].s = { ...(ws[addr].s || {}), ...style };
}

function setRangeStyle(ws, r1, c1, r2, c2, style) {
    for (let r = r1; r <= r2; r += 1) {
        for (let c = c1; c <= c2; c += 1) {
            const addr = XLSX.utils.encode_cell({ r, c });
            setCellStyle(ws, addr, style);
        }
    }
}

function buildStyledReportWorkbook() {
    const wb = XLSX.utils.book_new();
    const border = styleBorder();

    const liveStock = calculateLiveStock();
    const hasRows = liveStock.length > 0;
    const allNoRisk = hasRows && liveStock.every((row) => Number(row.available) >= Number(row.moq));
    const anyRisk = hasRows && liveStock.some((row) => Number(row.available) < Number(row.moq));
    const titleRgb = allNoRisk ? '92D050' : 'FF0000';

    const liveHeaders = ['S.No', 'Product Code', 'Product Description', 'UOM', 'Available Quantity', 'MOQ / ROL', 'Risk Level'];
    const liveRows = liveStock.map((row, idx) => [
        idx + 1,
        row.code,
        row.desc,
        row.uom,
        Number(row.available),
        Number(row.moq),
        Number(row.available) < Number(row.moq) ? 'Risk' : 'No Risk'
    ]);
    const liveAoa = [
        [ 'YPIPL - Borg Warner Stock Register', ...Array(liveHeaders.length - 1).fill('') ],
        liveHeaders,
        ...liveRows
    ];
    const wsLive = XLSX.utils.aoa_to_sheet(liveAoa);
    wsLive['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: liveHeaders.length - 1 } }];
    wsLive['!cols'] = [
        { wch: 6 }, { wch: 18 }, { wch: 28 }, { wch: 8 }, { wch: 18 }, { wch: 12 }, { wch: 12 }
    ];

    setRangeStyle(wsLive, 0, 0, 0, liveHeaders.length - 1, {
        font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 12 },
        fill: styleFill(titleRgb),
        alignment: { horizontal: 'center', vertical: 'center' },
        border
    });
    setRangeStyle(wsLive, 1, 0, 1, liveHeaders.length - 1, {
        font: { bold: true, color: { rgb: '000000' } },
        fill: styleFill('FCE4D6'),
        alignment: { horizontal: 'center', vertical: 'center' },
        border
    });
    if (allNoRisk) setCellStyle(wsLive, XLSX.utils.encode_cell({ r: 1, c: 6 }), { fill: styleFill('92D050') });
    if (anyRisk) setCellStyle(wsLive, XLSX.utils.encode_cell({ r: 1, c: 6 }), { fill: styleFill('FF0000'), font: { bold: true, color: { rgb: 'FFFFFF' } } });
    setRangeStyle(wsLive, 2, 0, 1 + liveRows.length, liveHeaders.length - 1, { border, alignment: { horizontal: 'center', vertical: 'center' } });
    for (let i = 0; i < liveRows.length; i += 1) {
        const risk = liveRows[i][6] === 'Risk';
        const addr = XLSX.utils.encode_cell({ r: 2 + i, c: 6 });
        setCellStyle(wsLive, addr, risk ? { fill: styleFill('FF0000'), font: { bold: true, color: { rgb: 'FFFFFF' } } } : { fill: styleFill('92D050'), font: { bold: true, color: { rgb: '000000' } } });
    }
    XLSX.utils.book_append_sheet(wb, wsLive, 'Live Stock Dashboard');

    const inwardFiltered = inwardData.filter((row) => {
        if (!tableFilters.inward.from && !tableFilters.inward.to) return true;
        const d = parseDdMmYyyy(row && row["Date"]);
        return isDateInRange(d, tableFilters.inward.from, tableFilters.inward.to);
    });
    const inwardHeaders = ['S.No', 'Date', 'DC No / Inv No', 'Part Code', 'Quantity', 'Location', 'Remarks'];
    const inwardRows = inwardFiltered.map((row, idx) => [
        idx + 1,
        row["Date"] || '',
        row["DC No / Inv No"] || '',
        inwardCode(row) || '',
        inwardQty(row),
        row["Location"] || '',
        row["Remarks"] || ''
    ]);
    const inwardAoa = [
        ['Borg Warner Stock Inward Register', ...Array(inwardHeaders.length - 1).fill('')],
        inwardHeaders,
        ...inwardRows
    ];
    const wsIn = XLSX.utils.aoa_to_sheet(inwardAoa);
    wsIn['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: inwardHeaders.length - 1 } }];
    wsIn['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 18 }, { wch: 16 }, { wch: 10 }, { wch: 14 }, { wch: 18 }];
    setRangeStyle(wsIn, 0, 0, 0, inwardHeaders.length - 1, { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: styleFill('0070C0'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsIn, 1, 0, 1, inwardHeaders.length - 1, { font: { bold: true, color: { rgb: '000000' } }, fill: styleFill('DDEBF7'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsIn, 2, 0, 1 + inwardRows.length, inwardHeaders.length - 1, { border, alignment: { horizontal: 'center', vertical: 'center' } });
    for (let i = 0; i < inwardRows.length; i += 1) {
        const addr = XLSX.utils.encode_cell({ r: 2 + i, c: 4 });
        setCellStyle(wsIn, addr, { fill: styleFill('FFC7CE'), font: { color: { rgb: '9C0006' } } });
    }
    XLSX.utils.book_append_sheet(wb, wsIn, 'Stock Inward');

    const outwardFiltered = outwardData.filter((row) => {
        if (!tableFilters.outward.from && !tableFilters.outward.to) return true;
        const d = parseDdMmYyyy(row && row["Date"]);
        return isDateInRange(d, tableFilters.outward.from, tableFilters.outward.to);
    });
    const outwardHeaders = ['S.No', 'Date', 'Invoice No', 'DC No', 'Product Code', 'Quantity', 'Delivery Location', 'Approved By', 'Remarks'];
    const outwardRows = outwardFiltered.map((row, idx) => [
        idx + 1,
        row["Date"] || '',
        row["Invoice No"] || '',
        row["DC No"] || '',
        outwardCode(row) || '',
        outwardQty(row),
        row["Delivery Location"] || '',
        row["Approved By"] || '',
        row["Remarks"] || ''
    ]);
    const outwardAoa = [
        ['Borg Warner Stock Outward Register', ...Array(outwardHeaders.length - 1).fill('')],
        outwardHeaders,
        ...outwardRows
    ];
    const wsOut = XLSX.utils.aoa_to_sheet(outwardAoa);
    wsOut['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: outwardHeaders.length - 1 } }];
    wsOut['!cols'] = [{ wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 18 }, { wch: 14 }, { wch: 18 }];
    setRangeStyle(wsOut, 0, 0, 0, outwardHeaders.length - 1, { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: styleFill('DA70D6'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsOut, 1, 0, 1, outwardHeaders.length - 1, { font: { bold: true, color: { rgb: '000000' } }, fill: styleFill('F2E0F7'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsOut, 2, 0, 1 + outwardRows.length, outwardHeaders.length - 1, { border, alignment: { horizontal: 'center', vertical: 'center' } });
    XLSX.utils.book_append_sheet(wb, wsOut, 'Stock Outward');

    const masterHeaders = ['S.No', 'Product Code', 'Product Description', 'MOQ / ROL', 'UOM'];
    const masterRows = masterData.map((row, idx) => [
        idx + 1,
        masterCode(row) || '',
        masterDesc(row) || '',
        masterMoq(row),
        masterUom(row) || ''
    ]);
    const masterAoa = [
        ['Borg Warner Masters', ...Array(masterHeaders.length - 1).fill('')],
        masterHeaders,
        ...masterRows
    ];
    const wsMaster = XLSX.utils.aoa_to_sheet(masterAoa);
    wsMaster['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: masterHeaders.length - 1 } }];
    wsMaster['!cols'] = [{ wch: 6 }, { wch: 18 }, { wch: 28 }, { wch: 12 }, { wch: 10 }];
    setRangeStyle(wsMaster, 0, 0, 0, masterHeaders.length - 1, { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: styleFill('002060'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsMaster, 1, 0, 1, masterHeaders.length - 1, { font: { bold: true, color: { rgb: '000000' } }, fill: styleFill('FCE4D6'), alignment: { horizontal: 'center', vertical: 'center' }, border });
    setRangeStyle(wsMaster, 2, 0, 1 + masterRows.length, masterHeaders.length - 1, { border, alignment: { horizontal: 'center', vertical: 'center' } });
    XLSX.utils.book_append_sheet(wb, wsMaster, 'Master');

    return wb;
}

document.getElementById('export-report').addEventListener('click', function() {
    try {
        const wb = buildStyledReportWorkbook();
        const fileName = `BW_Stock_Report_${toDdMmYyyy(new Date())}.xlsx`;
        XLSX.writeFile(wb, fileName, { cellStyles: true });
    } catch {
        setRibbonStatus('Export failed.', '#a80000');
    }
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const openLocalBtn = document.getElementById('open-local-db');
    if (openLocalBtn) {
        openLocalBtn.addEventListener('click', () => {
            openLocalDbWithAutoSave().catch(() => {
                setRibbonStatus('Open Local DB failed.', '#a80000');
            });
        });
    }

    const loadedFromLocalStorage = loadLocalState();
    wireMasterOnlyInputs();
    refreshAllTables();

    tryRestoreLocalDbAutoSave().then((restored) => {
        if (restored) {
            refreshAllTables();
            setRibbonStatus('Local DB reconnected (auto-save ON)', '#107c41');
            return;
        }

        if (loadedFromLocalStorage) {
            setRibbonStatus('Restored from browser storage (refresh safe). Open Local DB to save into Excel.', '#605e5c');
        } else if (supportsLocalFileAutoSave()) {
            setRibbonStatus('Open Local DB to enable auto-save, or use Save Database to download.', '#605e5c');
        } else {
            setRibbonStatus('Use Save Database to download (auto-save not supported in this browser).', '#605e5c');
        }
    }).catch(() => {
        if (loadedFromLocalStorage) {
            setRibbonStatus('Restored from browser storage (refresh safe). Open Local DB to save into Excel.', '#605e5c');
        }
    });

    if (isGoogleSyncEnabled()) {
        loadFromGoogleSheet().then((loaded) => {
            if (loaded) {
                refreshAllTables();
                saveLocalState();
            }
        }).catch(() => {
            setRibbonStatus('Google Sheet connect failed. Using local data.', '#a80000');
        });
    }

    const inApply = document.getElementById('in-filter-apply');
    const inClear = document.getElementById('in-filter-clear');
    const inFrom = document.getElementById('in-filter-from');
    const inTo = document.getElementById('in-filter-to');
    if (inApply && inFrom && inTo) {
        inApply.addEventListener('click', () => {
            tableFilters.inward.from = parseYyyyMmDd(inFrom.value);
            tableFilters.inward.to = parseYyyyMmDd(inTo.value);
            refreshAllTables();
        });
    }
    if (inClear && inFrom && inTo) {
        inClear.addEventListener('click', () => {
            tableFilters.inward.from = null;
            tableFilters.inward.to = null;
            inFrom.value = '';
            inTo.value = '';
            refreshAllTables();
        });
    }

    const outApply = document.getElementById('out-filter-apply');
    const outClear = document.getElementById('out-filter-clear');
    const outFrom = document.getElementById('out-filter-from');
    const outTo = document.getElementById('out-filter-to');
    if (outApply && outFrom && outTo) {
        outApply.addEventListener('click', () => {
            tableFilters.outward.from = parseYyyyMmDd(outFrom.value);
            tableFilters.outward.to = parseYyyyMmDd(outTo.value);
            refreshAllTables();
        });
    }
    if (outClear && outFrom && outTo) {
        outClear.addEventListener('click', () => {
            tableFilters.outward.from = null;
            tableFilters.outward.to = null;
            outFrom.value = '';
            outTo.value = '';
            refreshAllTables();
        });
    }
});

document.getElementById('inward-table').addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    if (btn.getAttribute('data-action') !== 'delete-inward') return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const idx = inwardData.findIndex(r => r && r._id === id);
    if (idx === -1) return;
    if (!canDeleteRowByPolicy(inwardData[idx])) return;
    if (!window.confirm('Delete this inward entry?')) return;
    inwardData.splice(idx, 1);
    refreshAllTables();
    saveLocalState();
    scheduleGoogleAutoSave('inward:delete');
    scheduleLocalAutoSave();
});

document.getElementById('outward-table').addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
    if (!btn) return;
    if (btn.getAttribute('data-action') !== 'delete-outward') return;
    const id = btn.getAttribute('data-id');
    if (!id) return;
    const idx = outwardData.findIndex(r => r && r._id === id);
    if (idx === -1) return;
    if (!canDeleteRowByPolicy(outwardData[idx])) return;
    if (!window.confirm('Delete this outward entry?')) return;
    outwardData.splice(idx, 1);
    refreshAllTables();
    saveLocalState();
    scheduleGoogleAutoSave('outward:delete');
    scheduleLocalAutoSave();
});
