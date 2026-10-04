(function () {
    'use strict';

    const body = document.body;
    const suite = String(body.dataset.suite || '').trim().toLowerCase();
    const app = document.getElementById('app');
    const charts = [];
    const state = {
        payload: null,
        visualLayoutOverrides: {},
        defaultLayout: {},
        visualElements: new Map(),
        layoutZ: 100,
        canvasMinHeight: 960
    };

    // ── localStorage persistence (same pattern as canvas-host.js) ──
    var LAYOUT_KEY = 'exec-layout-' + suite;
    function saveLayout() {
        try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.visualLayoutOverrides)); }
        catch (e) {}
    }
    function loadLayout() {
        try {
            var saved = localStorage.getItem(LAYOUT_KEY);
            if (saved) {
                var parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') state.visualLayoutOverrides = parsed;
            }
        } catch (e) {}
    }
    function clearLayout() {
        try { localStorage.removeItem(LAYOUT_KEY); } catch (e) {}
        state.visualLayoutOverrides = {};
    }
    loadLayout();

    // Multi.cshtml already reads this object immediately before saving the SQL layout.
    window.__csrDashboardInstance = { state };
        window.__execResetLayout = function() {
            clearLayout();
            state.visualElements.forEach(function(element, id) {
                applyVisualGeometry(element, visualGeometry(id));
                var chart = charts.find(function(c) { return c.getDom() === element.querySelector('.exec-chart'); });
            });
            resizeChartsSoon();
        };

    function palette() {
        const styles = getComputedStyle(document.documentElement);
        const values = [
            styles.getPropertyValue('--exec-primary').trim(),
            styles.getPropertyValue('--exec-secondary').trim(),
            styles.getPropertyValue('--exec-highlight').trim(),
            styles.getPropertyValue('--exec-accent').trim(),
            '#4C6FFF', '#2DD4BF', '#FBBF24', '#845EF7'
        ].filter(Boolean);
        return [...new Set(values)];
    }

    function esc(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function number(value) {
        // Number(null), Number(undefined) and Number('') can incorrectly become 0.
        // Missing MoM/YoY values must remain missing, not render as 0.0%.
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function formatValue(value, format) {
        const n = number(value);
        if (n === null) return '—';

        const type = String(format || 'number').toLowerCase();

        // Currency and ordinary numeric values use full comma-grouped integers.
        // Examples: 0, 950, 1,234, 12,345. No CA$, $, decimals, K, or M.
        if (type === 'currency' || type === 'currency2' ||
            type === 'number' || type === 'decimal' || type === 'decimal2') {
            return n.toLocaleString(undefined, {
                useGrouping: true,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            });
        }

        if (type === 'percent') {
            return n.toLocaleString(undefined, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1
            }) + '%';
        }

        if (type === 'percent2') {
            return n.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }) + '%';
        }

        return n.toLocaleString(undefined, {
            useGrouping: true,
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
        });
    }

    function deltaText(value, mode) {
        const n = number(value);
        if (n === null) return '—';
        const sign = n > 0 ? '+' : '';
        return sign + n.toFixed(1) + (String(mode).toLowerCase() === 'points' ? ' pts' : '%');
    }

    function deltaTone(value, positiveIsGood) {
        const n = number(value);
        if (n === null || n === 0) return 'neutral';
        const good = positiveIsGood === false ? n < 0 : n > 0;
        return good ? 'good' : 'bad';
    }

    function clampNumber(value, min, max) {
        const n = Number(value);
        return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
    }

    function normalizeVisualLayout(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
        const out = {};
        Object.entries(value).forEach(([id, raw]) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
            const w = clampNumber(raw.w, 4, 100);
            const h = clampNumber(raw.h, 4, 100);
            out[String(id)] = {
                x: clampNumber(raw.x, 0, Math.max(0, 100 - w)),
                y: clampNumber(raw.y, 0, Math.max(0, 100 - h)),
                w,
                h,
                z: Number(raw.z || 0) || 0
            };
        });
        return out;
    }

    function visualSpan(item, metricCount) {
        if (item.__type === 'metric') {
            if (metricCount <= 1) return 12;
            if (metricCount === 2) return 6;
            if (metricCount === 3) return 4;
            return 3;
        }
        if (item.width === 'wide') return 12;
        if (item.width === 'third') return 4;
        if (item.width === 'two-thirds') return 8;
        return 6;
    }

    function visualHeightUnits(item) {
        if (item.__type === 'metric') return 2.1;
        if (item.__type === 'table') {
            const rowCount = Array.isArray(item.rows) ? item.rows.length : 0;
            const base = String(item.kind || '').toLowerCase() === 'hierarchy' ? 4.8 : 4.1;
            const rowUnits = Math.min(4.8, Math.max(0, rowCount - 4) * 0.18);
            return Math.max(item.width === 'wide' ? 4.8 : 4.4, base + rowUnits);
        }
        if (item.kind === 'pie') return 4.1;
        return item.width === 'wide' ? 4.7 : 4.3;
    }

    function buildVisualModels(payload) {
        const models = [];
        (payload.metrics || []).forEach((metric, index) => {
            models.push({ ...metric, __type: 'metric', __id: `metric:${metric.key || index}` });
        });
        (payload.charts || []).forEach((chart, index) => {
            models.push({ ...chart, __type: 'chart', __id: `chart:${chart.id || index}` });
        });
        (payload.tables || []).forEach((table, index) => {
            models.push({ ...table, __type: 'table', __id: `table:${table.id || index}` });
        });
        return models;
    }

    function createDefaultLayout(models) {
        const metricCount = models.filter(item => item.__type === 'metric').length;
        const placements = [];
        let x = 0;
        let y = 0;
        let rowHeight = 0;
        const gapUnits = 0.14;

        for (const item of models) {
            const span = visualSpan(item, metricCount);
            const height = visualHeightUnits(item);
            if (x > 0 && x + span > 12.001) {
                y += rowHeight + gapUnits;
                x = 0;
                rowHeight = 0;
            }
            placements.push({ id: item.__id, x, y, span, height });
            x += span;
            rowHeight = Math.max(rowHeight, height);
        }

        const totalUnits = Math.max(6, y + rowHeight);
        const horizontalGapPct = 0.32;
        const verticalGapPct = 0.45;
        const result = {};
        placements.forEach((placement, index) => {
            const left = placement.x / 12 * 100;
            const width = placement.span / 12 * 100;
            result[placement.id] = {
                x: left + horizontalGapPct / 2,
                y: placement.y / totalUnits * 100 + verticalGapPct / 2,
                w: Math.max(4, width - horizontalGapPct),
                h: Math.max(4, placement.height / totalUnits * 100 - verticalGapPct),
                z: 100 + index
            };
        });

        state.canvasMinHeight = Math.max(960, Math.round(totalUnits * 120));
        return result;
    }

    function visualGeometry(id) {
        const base = state.defaultLayout[id] || { x: 0, y: 0, w: 50, h: 25, z: 0 };
        const override = state.visualLayoutOverrides[id] || {};
        const w = clampNumber(override.w ?? base.w, 4, 100);
        const h = clampNumber(override.h ?? base.h, 4, 100);
        return {
            x: clampNumber(override.x ?? base.x, 0, Math.max(0, 100 - w)),
            y: clampNumber(override.y ?? base.y, 0, Math.max(0, 100 - h)),
            w,
            h,
            z: Number(override.z ?? base.z ?? 0) || 0
        };
    }

    function applyVisualGeometry(element, geometry) {
        if (!element || !geometry) return;
        element.style.left = `${geometry.x}%`;
        element.style.top = `${geometry.y}%`;
        element.style.width = `${geometry.w}%`;
        element.style.height = `${geometry.h}%`;
        element.style.zIndex = String(geometry.z || 0);
    }

    function resizeChartsSoon() {
        requestAnimationFrame(() => charts.forEach(chart => chart.resize()));
        setTimeout(() => charts.forEach(chart => chart.resize()), 80);
    }

    function publishVisualLayout() {
        try {
            window.parent.postMessage({
                type: 'csr-dashboard-visual-layout:changed',
                templateId: `executive-${suite}`,
                visualLayout: state.visualLayoutOverrides
            }, window.location.origin);
        } catch (_) { }
    }

    function applyExternalVisualLayout(value) {
        state.visualLayoutOverrides = normalizeVisualLayout(value);
        state.visualElements.forEach((element, id) => {
            applyVisualGeometry(element, visualGeometry(id));
        });
        resizeChartsSoon();
    }

    function enableVisualLayoutHandles(canvas, element, model) {
        if (!canvas || !element || !model) return;
        const visualId = String(model.__id || '');
        const move = document.createElement('button');
        move.type = 'button';
        move.className = 'exec-layout-move';
        move.setAttribute('aria-label', `Move ${model.title || model.label || 'visual'}`);
        move.title = 'Drag visual. Double-click to reset position.';
        move.innerHTML = '<span aria-hidden="true">⠿</span>';

        const resize = document.createElement('span');
        resize.className = 'exec-layout-resize';
        resize.title = 'Resize visual';
        element.append(move, resize);

        const begin = (event, mode) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            const canvasRect = canvas.getBoundingClientRect();
            if (!canvasRect.width || !canvasRect.height) return;
            const start = visualGeometry(visualId);
            const pointerX = event.clientX;
            const pointerY = event.clientY;
            state.layoutZ = Math.max(state.layoutZ, start.z || 0) + 1;
            start.z = state.layoutZ;
            applyVisualGeometry(element, start);
            element.classList.add('exec-layout-active');
            canvas.classList.add('exec-layout-changing');
            try { event.currentTarget.setPointerCapture(event.pointerId); } catch (_) { }

            const onMove = moveEvent => {
                const dx = ((moveEvent.clientX - pointerX) / canvasRect.width) * 100;
                const dy = ((moveEvent.clientY - pointerY) / canvasRect.height) * 100;
                const next = { ...start };
                if (mode === 'move') {
                    next.x = clampNumber(start.x + dx, 0, Math.max(0, 100 - start.w));
                    next.y = clampNumber(start.y + dy, 0, Math.max(0, 100 - start.h));
                } else {
                    next.w = clampNumber(start.w + dx, 4, Math.max(4, 100 - start.x));
                    next.h = clampNumber(start.h + dy, 4, Math.max(4, 100 - start.y));
                }
                applyVisualGeometry(element, next);
                resizeChartsSoon();
            };

            const finish = () => {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', finish, true);
                window.removeEventListener('pointercancel', finish, true);
                element.classList.remove('exec-layout-active');
                canvas.classList.remove('exec-layout-changing');

                const canvasBox = canvas.getBoundingClientRect();
                const box = element.getBoundingClientRect();
                const geometry = {
                    x: clampNumber(((box.left - canvasBox.left) / canvasBox.width) * 100, 0, 100),
                    y: clampNumber(((box.top - canvasBox.top) / canvasBox.height) * 100, 0, 100),
                    w: clampNumber((box.width / canvasBox.width) * 100, 4, 100),
                    h: clampNumber((box.height / canvasBox.height) * 100, 4, 100),
                    z: Number(element.style.zIndex || start.z || 0)
                };
                geometry.x = clampNumber(geometry.x, 0, Math.max(0, 100 - geometry.w));
                geometry.y = clampNumber(geometry.y, 0, Math.max(0, 100 - geometry.h));
                state.visualLayoutOverrides[visualId] = geometry;
                saveLayout();
                publishVisualLayout();
                resizeChartsSoon();
            };

            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', finish, true);
            window.addEventListener('pointercancel', finish, true);
        };

        move.addEventListener('pointerdown', event => begin(event, 'move'));
        resize.addEventListener('pointerdown', event => begin(event, 'resize'));
        move.addEventListener('dblclick', event => {
            event.preventDefault();
            event.stopPropagation();
            delete state.visualLayoutOverrides[visualId];
            saveLayout();
            applyVisualGeometry(element, visualGeometry(visualId));
            publishVisualLayout();
            resizeChartsSoon();
        });
    }

    function renderMetric(metric) {
        return `
      <div class="exec-metric-label">${esc(metric.label)}</div>
      <div class="exec-metric-main">
        <div class="exec-metric-value">${formatValue(metric.value, metric.format)}</div>
        <div class="exec-metric-period">${esc(metric.period || '')}</div>
      </div>
      <div class="exec-deltas">
        <span class="exec-delta ${deltaTone(metric.mom, metric.positiveIsGood)}">${esc(metric.momLabel || 'MoM')} ${deltaText(metric.mom, metric.deltaMode)}</span>
        <span class="exec-delta ${deltaTone(metric.yoy, metric.positiveIsGood)}">${esc(metric.yoyLabel || 'YoY')} ${deltaText(metric.yoy, metric.deltaMode)}</span>
      </div>`;
    }

    function renderTable(table) {
        const columns = Array.isArray(table.columns) ? table.columns : [];
        const rows = Array.isArray(table.rows) ? table.rows : [];
        if (!columns.length || !rows.length) return '<div class="exec-empty">No data.</div>';

        const formats = table.formats || {};
        const groups = Array.isArray(table.columnGroups) ? table.columnGroups : [];
        const kind = String(table.kind || 'table').toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const groupByColumn = new Map();
        groups.forEach((group, groupIndex) => {
            (Array.isArray(group.columns) ? group.columns : []).forEach(column => {
                groupByColumn.set(column, { group, groupIndex });
            });
        });

        let headerHtml;
        if (groups.length) {
            const emitted = new Set();
            const topCells = [];
            const lowerCells = [];
            columns.forEach(column => {
                const hit = groupByColumn.get(column);
                if (!hit) {
                    topCells.push(`<th class="exec-matrix-row-header" rowspan="2">${esc(column)}</th>`);
                    return;
                }
                if (!emitted.has(hit.groupIndex)) {
                    emitted.add(hit.groupIndex);
                    const span = (Array.isArray(hit.group.columns) ? hit.group.columns : []).filter(name => columns.includes(name)).length;
                    topCells.push(`<th class="exec-column-group" colspan="${Math.max(1, span)}">${esc(hit.group.label || '')}</th>`);
                }
                lowerCells.push(`<th class="exec-matrix-leaf-header">${esc(column.replace(/^.*?\s(?=(Accts|Accounts|Balance|Post Paid|Paid Ratio|Amount In)$)/, ''))}</th>`);
            });
            headerHtml = `<tr class="exec-matrix-group-row">${topCells.join('')}</tr><tr class="exec-matrix-leaf-row">${lowerCells.join('')}</tr>`;
        } else {
            headerHtml = `<tr>${columns.map(column => `<th>${esc(column)}</th>`).join('')}</tr>`;
        }

        const bodyHtml = rows.map(row => {
            const rowType = String(row.__rowType || '').toLowerCase();
            if (rowType === 'group') {
                const label = row.__label ?? row[columns[0]] ?? '';
                return `<tr class="group"><td colspan="${columns.length}">${esc(label)}</td></tr>`;
            }

            const rowClasses = [];
            if (rowType) rowClasses.push(rowType.replace(/[^a-z0-9_-]/g, ''));
            const rowFormats = row.__formats && typeof row.__formats === 'object' ? row.__formats : {};
            const cellTones = row.__cellTones && typeof row.__cellTones === 'object' ? row.__cellTones : {};
            const indent = Math.max(0, Number(row.__indent) || 0);

            return `<tr class="${rowClasses.join(' ')}">${columns.map((column, columnIndex) => {
                const raw = row[column];
                const fmt = rowFormats[column] || formats[column];
                const tone = String(cellTones[column] || '').toLowerCase();
                const classes = [];
                if (tone === 'good' || tone === 'bad' || tone === 'neutral') classes.push(`tone-${tone}`);
                if (columnIndex === 0 && indent > 0) classes.push('hierarchy-child');
                const style = columnIndex === 0 && indent > 0 ? ` style="padding-left:${8 + indent * 14}px"` : '';
                return `<td class="${classes.join(' ')}"${style}>${fmt ? formatValue(raw, fmt) : esc(raw ?? '')}</td>`;
            }).join('')}</tr>`;
        }).join('');

        const matrixClass = groups.length ? ' exec-table-matrix' : '';
        return `<div class="exec-table-wrap"><table class="exec-table exec-table-${kind}${matrixClass}">
      <thead>${headerHtml}</thead>
      <tbody>${bodyHtml}</tbody>
    </table></div>`;
    }

    function chartOption(chart) {
        const categories = Array.isArray(chart.categories) ? chart.categories : [];
        const series = Array.isArray(chart.series) ? chart.series : [];
        const kind = String(chart.kind || 'line').toLowerCase();

        if (kind === 'pie' || kind === 'donut') {
            const first = series[0] || { data: [] };
            const data = categories.map((name, index) => ({ name, value: number(first.data?.[index]) ?? 0 }));
            return {
                color: palette(),
                tooltip: { 
                    trigger: 'item', 
                    valueFormatter: v => formatValue(v, chart.valueFormat || 'number'),
                    backgroundColor: 'rgba(255,255,255,0.97)',
                    borderColor: 'rgba(99,102,241,0.30)',
                    borderWidth: 1,
                    textStyle: { color: '#1e293b', fontSize: 11, fontWeight: 600 }
                },
                legend: { bottom: 2, type: 'scroll', textStyle: { fontSize: 10, color: '#1e293b', fontWeight: 600 } },
                series: [{ 
                    type: 'pie', 
                    radius: kind === 'donut' ? ['40%', '68%'] : ['44%', '70%'], 
                    center: ['50%', '45%'], 
                    label: { 
                        fontSize: 10, 
                        color: '#1e293b', 
                        fontWeight: 600,
                        formatter: '{b}: {d}%'
                    },
                    labelLine: { lineStyle: { color: '#64748b' } },
                    data 
                }]
            };
        }

        if (kind === 'heatmap') {
            // Heatmap: series = rows (time slots), categories = columns (days)
            // Build [dayIndex, timeIndex, value] data points
            const days = categories; // ["Mon", "Tue", ...]
            const times = series.map(s => s.name); // ["9 AM", "12 PM", ...]
            const heatData = [];
            series.forEach((s, ti) => {
                (s.data || []).forEach((val, di) => {
                    heatData.push([di, ti, number(val) ?? 0]);
                });
            });
            const maxVal = Math.max(...heatData.map(d => d[2]), 100);
            return {
                tooltip: {
                    position: 'top',
                    formatter: function(p) {
                        return days[p.value[0]] + ' ' + times[p.value[1]] + '<br/>Utilization: ' + p.value[2] + '%';
                    },
                    backgroundColor: 'rgba(255,255,255,0.97)',
                    borderColor: 'rgba(99,102,241,0.30)',
                    borderWidth: 1,
                    textStyle: { color: '#1e293b', fontSize: 11, fontWeight: 600 }
                },
                grid: { left: 48, right: 12, top: 8, bottom: 30, containLabel: true },
                xAxis: {
                    type: 'category',
                    data: days,
                    splitArea: { show: true },
                    axisLabel: { fontSize: 9, color: '#1e293b', fontWeight: 600 },
                    axisLine: { show: false },
                    axisTick: { show: false }
                },
                yAxis: {
                    type: 'category',
                    data: times,
                    splitArea: { show: true },
                    axisLabel: { fontSize: 9, color: '#1e293b', fontWeight: 600 },
                    axisLine: { show: false },
                    axisTick: { show: false }
                },
                visualMap: {
                    min: 0,
                    max: maxVal,
                    calculable: false,
                    orient: 'horizontal',
                    left: 'center',
                    bottom: 2,
                    itemWidth: 12,
                    itemHeight: 80,
                    textStyle: { fontSize: 8, color: '#1e293b' },
                    inRange: { color: ['#e0e7ff', '#818cf8', '#4c6fff', '#0808ee'] }
                },
                series: [{
                    type: 'heatmap',
                    data: heatData,
                    label: { show: true, fontSize: 8, fontWeight: 700, color: '#fff',
                        formatter: function(p) { return p.value[2] + '%'; } },
                    emphasis: { itemStyle: { shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.3)' } }
                }]
            };
        }

        const hasSecondAxis = series.some(item => String(item.axis || '').toLowerCase() === 'right');
        const colors = palette();
        const echartsSeries = series.map((item, index) => {
            const type = String(item.type || (kind === 'bar' ? 'bar' : 'line')).toLowerCase();
            const out = {
                name: item.name,
                type: type === 'stackedbar' ? 'bar' : type,
                data: Array.isArray(item.data) ? item.data : [],
                yAxisIndex: String(item.axis || '').toLowerCase() === 'right' ? 1 : 0,
                smooth: !!item.smooth,
                symbol: type === 'line' ? 'circle' : undefined,
                symbolSize: type === 'line' ? 5 : undefined,
                lineStyle: type === 'line' ? { width: 2.5 } : undefined,
                barMaxWidth: 28,
                itemStyle: { color: item.color || colors[index % colors.length] }
            };
            if (type === 'stackedbar' || item.stack) out.stack = item.stack || 'total';
            return out;
        });

        const axisFormatter = value => {
            const n = Number(value);
            if (!Number.isFinite(n)) return '';
            return n.toLocaleString(undefined, {
                useGrouping: true,
                minimumFractionDigits: 0,
                maximumFractionDigits: 0
            });
        };

        return {
            color: colors,
            tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
            legend: { top: 2, type: 'scroll', textStyle: { fontSize: 9, color: '#1e293b', fontWeight: 600 }, itemWidth: 8, itemHeight: 8, itemGap: 4 },
            grid: { left: 52, right: hasSecondAxis ? 52 : 18, top: 28, bottom: 38 },
            xAxis: {
                type: 'category',
                data: categories,
                axisLabel: { color: '#1e293b', fontSize: 9, interval: 0, hideOverlap: true, fontWeight: 600 },
                axisLine: { lineStyle: { color: '#94a3b8' } },
                axisTick: { show: false }
            },
            yAxis: [
                { type: 'value', name: chart.leftAxisTitle || '', nameTextStyle: { fontSize: 8 }, axisLabel: { formatter: axisFormatter, fontSize: 9, color: '#1e293b', fontWeight: 600 }, splitLine: { lineStyle: { color: '#cbd5e1' } } },
                ...(hasSecondAxis ? [{ type: 'value', name: chart.rightAxisTitle || '', nameTextStyle: { fontSize: 8 }, axisLabel: { formatter: axisFormatter, fontSize: 9, color: '#1e293b', fontWeight: 600 }, splitLine: { show: false } }] : [])
            ],
            series: echartsSeries
        };
    }

    function render(payload) {
        state.payload = payload;
        const models = buildVisualModels(payload);
        state.defaultLayout = createDefaultLayout(models);
        state.visualElements.clear();

        app.innerHTML = `<main class="exec-page">
      <header class="exec-header">
        <div class="exec-title">${esc(payload.title || '')}</div>
        <div class="exec-header-right">
          <div class="exec-asof">${esc(payload.asOfLabel || '')}</div>
          <button class="exec-edit-btn" type="button" id="execEditBtn" title="Click to unlock editing — then drag the ⠿ handle to move visuals, or drag the bottom-right corner to resize. Click Done to save your layout and freeze."><i class="fa-solid fa-pen-to-square"></i> Edit</button>
          <button class="exec-reset-btn" type="button" onclick="if(confirm('Reset all visuals to default positions?')) { window.__execResetLayout(); }"><i class="fa-solid fa-rotate-left"></i> Reset</button>
        </div>
      </header>
      <div class="exec-canvas" style="min-height:calc(100vh - 120px)" data-design-height="960"></div>
      ${Array.isArray(payload.notes) && payload.notes.length
                ? `<div class="exec-ai-brief" data-ai-brief>
                     <div class="exec-ai-brief-head">
                       <div class="exec-ai-brief-title">
                         <span class="exec-ai-brief-spark" aria-hidden="true">
                           <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v6m0 8v6m10-10h-6m-8 0H2m13.5-5.5l-2.5 2.5m-6 6l-2.5 2.5m11 0l-2.5-2.5m-6-6L4.5 4.5"/></svg>
                         </span>
                         <span>AI Brief</span>
                       </div>
                       <div class="exec-ai-brief-badge" data-ai-badge>
                         <span class="exec-ai-brief-dot"></span>
                         <span class="exec-ai-brief-badge-text">AI-wired</span>
                       </div>
                     </div>
                     <div class="exec-ai-brief-grid" data-ai-brief-grid>
                       <div class="exec-ai-brief-cell exec-ai-brief-what" data-section="what">
                         <div class="exec-ai-brief-cell-head">
                           <span class="exec-ai-brief-cell-icon">✓</span>
                           <span class="exec-ai-brief-cell-label">What happened</span>
                         </div>
                         <div class="exec-ai-brief-cell-body" data-brief-body></div>
                       </div>
                       <div class="exec-ai-brief-cell exec-ai-brief-why" data-section="why">
                         <div class="exec-ai-brief-cell-head">
                           <span class="exec-ai-brief-cell-icon">?</span>
                           <span class="exec-ai-brief-cell-label">Why</span>
                         </div>
                         <div class="exec-ai-brief-cell-body" data-brief-body></div>
                       </div>
                       <div class="exec-ai-brief-cell exec-ai-brief-next" data-section="next">
                         <div class="exec-ai-brief-cell-head">
                           <span class="exec-ai-brief-cell-icon">→</span>
                           <span class="exec-ai-brief-cell-label">What to expect</span>
                         </div>
                         <div class="exec-ai-brief-cell-body" data-brief-body></div>
                       </div>
                       <div class="exec-ai-brief-cell exec-ai-brief-do" data-section="do">
                         <div class="exec-ai-brief-cell-head">
                           <span class="exec-ai-brief-cell-icon">⊕</span>
                           <span class="exec-ai-brief-cell-label">What to do</span>
                         </div>
                         <div class="exec-ai-brief-cell-body" data-brief-body></div>
                       </div>
                     </div>
                   </div>`
                : ''}
    </main>`;

        // The AI brief card ships with empty cells + shimmer state.
        // exec-ai-brief.js (loaded on the page) takes over: streams Groq
        // tokens into the cells, or — if Groq is truly offline — fills
        // them with the honest static notes from the payload.
        // If exec-ai-brief.js is NOT loaded on the page (no <script> tag),
        // we still want SOMETHING visible, so populate from notes as a
        // last-resort. We detect exec-ai-brief.js by checking whether its
        // init function left a marker on window.
        if (!window.__execAiBriefActive) {
          const briefHost = app.querySelector('[data-ai-brief]');
          if (briefHost && Array.isArray(payload.notes) && payload.notes.length) {
            const sectionOrder = ['what', 'why', 'next', 'do'];
            sectionOrder.forEach((sec, i) => {
              const cell = briefHost.querySelector('[data-section="' + sec + '"] [data-brief-body]');
              if (cell && payload.notes[i]) cell.textContent = payload.notes[i].replace(/^[A-Z ]+:/, '').trim();
            });
          }
        }

        const canvas = app.querySelector('.exec-canvas');
        charts.splice(0).forEach(chart => chart.dispose());

        // ─── Edit button: freeze/unfreeze drag+resize ───────────────────────
        // By default the canvas is FROZEN — drag/resize handles are hidden
        // (CSS: .exec-canvas-frozen .exec-layout-move/resize { display: none }).
        // Clicking "Edit" removes the frozen class → handles appear → user can
        // drag ⠿ to move or drag the bottom-right corner to resize.
        // Clicking "Done" (the button text changes) re-freezes + saves layout.
        const editBtn = app.querySelector('#execEditBtn');
        if (editBtn) {
            canvas.classList.add('exec-canvas-frozen');
            let editing = false;
            editBtn.addEventListener('click', function() {
                editing = !editing;
                if (editing) {
                    canvas.classList.remove('exec-canvas-frozen');
                    editBtn.innerHTML = '<i class="fa-solid fa-check"></i> Done';
                    editBtn.classList.add('is-active');
                } else {
                    canvas.classList.add('exec-canvas-frozen');
                    editBtn.innerHTML = '<i class="fa-solid fa-pen-to-square"></i> Edit';
                    editBtn.classList.remove('is-active');
                    saveLayout();
                }
            });
        }

        models.forEach((model, index) => {
            const section = document.createElement('section');
            section.className = model.__type === 'metric'
                ? `exec-visual exec-metric exec-metric-${index % 4}`
                : 'exec-visual exec-panel';
            section.dataset.execId = model.__id;

            if (model.__type === 'metric') {
                section.innerHTML = renderMetric(model);
            } else {
                section.innerHTML = `
          <div class="exec-panel-title">${esc(model.title || '')}</div>
          ${model.__type === 'table'
                        ? renderTable(model)
                        : `<div class="exec-chart" data-chart-id="${esc(model.id)}"></div>`}`;
            }

            canvas.appendChild(section);
            state.visualElements.set(model.__id, section);
            applyVisualGeometry(section, visualGeometry(model.__id));
            enableVisualLayoutHandles(canvas, section, model);
        });

        (payload.charts || []).forEach(chartModel => {
            const host = app.querySelector(`[data-chart-id="${CSS.escape(chartModel.id)}"]`);
            if (!host || !window.echarts) return;
            const chart = window.echarts.init(host);
            chart.setOption(chartOption(chartModel), true);
            charts.push(chart);
        });

        resizeChartsSoon();
    }

    async function load() {
        if (!suite) {
            app.innerHTML = '<div class="exec-error">Missing executive suite key.</div>';
            return;
        }
        app.innerHTML = '<div class="exec-loading">Loading dashboard data…</div>';
        try {
            const endpoint = new URL('../data/executive/' + suite + '.json', window.location.href);
            const response = await fetch(endpoint.toString(), { cache: 'no-store' });
            if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
            render(await response.json());
        } catch (error) {
            app.innerHTML = `<div class="exec-error">${esc(error?.message || error || 'Dashboard data failed to load.')}</div>`;
        }
    }

    const resize = () => {
        resizeChartsSoon();
        // On mobile/landscape: set canvas to fixed design height so tiles get
        // their full designed height (percentages need a real pixel parent).
        // Without this, landscape viewport is too short and charts get cut in half.
        const canvas = document.querySelector('.exec-canvas');
        if (canvas) {
            const designHeight = parseInt(canvas.dataset.designHeight || '960', 10);
            const isMobile = window.innerWidth < 1024;
            if (isMobile) {
                canvas.style.height = designHeight + 'px';
                canvas.style.minHeight = designHeight + 'px';
                canvas.style.overflow = 'visible';
                canvas.parentElement.style.overflowY = 'auto';
            } else {
                canvas.style.height = '';
                canvas.style.minHeight = 'calc(100vh - 120px)';
                canvas.style.overflow = '';
                canvas.parentElement.style.overflowY = '';
            }
            // Resize charts after canvas height settles
            setTimeout(() => resizeChartsSoon(), 50);
        }
    };
    window.addEventListener('resize', resize);
    window.addEventListener('message', event => {
        if (event.origin !== window.location.origin) return;
        const message = event.data || {};
        const type = String(message.type || '');
        if (type === 'dashboard-custom-html:layout') {
            applyExternalVisualLayout(message?.payload?.visualLayout ?? message?.visualLayout ?? {});
            return;
        }
        if (type.endsWith(':resize')) resizeChartsSoon();
    });

    // Tell the parent only after the layout listener and save-readable state exist.
    try {
        window.parent.postMessage({
            type: 'dashboard-custom-html:ready',
            templateId: `executive-${suite}`
        }, window.location.origin);
    } catch (_) { }

    load();
    // Apply canvas height fix after initial load
    setTimeout(() => resize(), 500);
})();