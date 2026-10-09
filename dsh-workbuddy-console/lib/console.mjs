/**
 * console.mjs — WorkBuddy 管理页（DSH 原生设置页）。
 *
 * 这是一个**浏览器端**组件模块，由 client.js 引入后注册到 `settings.section`
 * 槽位。它不是独立 Web 页面：不开 HTTP 路由、不需要 web/ 目录，
 * 数据通过 fetch 向 vendored 已存在的账号池路由取。
 *
 * 三个区域：
 *   1. 账号   —— 列出本机已登录账号、登录状态、额度、签到，可重新检测/签到
 *   2. 积分   —— 每个账号的额度总额与积分包明细
 *   3. 使用记录 —— 按天聚合的积分变化 + 明细表（来自 credit-store 的落盘数据）
 *
 * 与账号池卡片的区别：卡片管「模型勾选/分配策略」这类配置，
 * 本页管「看」——账号、额度、历史。两者互不干扰。
 */

/** 与 client.js 共享的 React 运行时 */
export function createConsoleSection({ react, jsxRuntime }) {
  const { useState, useEffect, useCallback, useMemo, createElement: h } = react;
  const { jsx, jsxs } = jsxRuntime;

  /** vendored 账号池的路由前缀（同 vendor/xdpool/lib/index.js 的常量） */
  const POOL_API = '/plugins/dsh-workbuddy-xdpool';
  /** 本插件自己的路由前缀（由 index.js 注册，提供历史记录） */
  const SELF_API = '/plugins/dsh-workbuddy-console';

  const CSS_ID = 'dsh-workbuddy-console/settings-page';
  const CSS = `
.wbc-page{align-self:stretch;display:flex;flex-direction:column;gap:20px;padding:4px 0 24px}
.wbc-head{display:flex;flex-direction:column;gap:4px}
.wbc-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.wbc-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.wbc-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbc-tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;padding:8px 12px}
.wbc-tab:hover{color:var(--dsw-alias-label-primary)}
.wbc-tab-on{border-bottom-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-label-primary);font-weight:600}
.wbc-body{display:flex;flex-direction:column;gap:16px}
.wbc-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wbc-spacer{flex:1}
.wbc-btn{appearance:none;background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px;padding:6px 12px}
.wbc-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-3)}
.wbc-btn:disabled{opacity:.5;cursor:default}
.wbc-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-1);border-color:transparent}
.wbc-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.wbc-err{color:var(--dsw-alias-label-error,#e5484d);font-size:12px}
.wbc-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.wbc-sum{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px}
.wbc-sum-label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}
.wbc-sum-value{font-size:22px;font-weight:600;color:var(--dsw-alias-label-primary);margin-top:6px;font-variant-numeric:tabular-nums}
.wbc-sum-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:4px}
.wbc-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px}
.wbc-card-off{opacity:.55}
.wbc-card-head{display:flex;align-items:center;gap:8px}
.wbc-name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-tag{border-radius:4px;font-size:10px;padding:2px 6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);flex:none}
.wbc-tag-on{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.wbc-tag-warn{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-error,#e5484d)}
.wbc-kv{display:flex;justify-content:space-between;gap:12px;font-size:12px}
.wbc-k{color:var(--dsw-alias-label-secondary)}
.wbc-v{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wbc-packs{display:flex;flex-direction:column;gap:4px;border-top:.5px solid var(--dsw-alias-border-l2);padding-top:8px}
.wbc-pack{display:flex;justify-content:space-between;gap:8px;font-size:11px}
.wbc-pack-name{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wbc-pack-val{color:var(--dsw-alias-label-primary);flex:none;font-variant-numeric:tabular-nums}
.wbc-empty{border:.5px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:28px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.wbc-table-wrap{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden}
.wbc-table{width:100%;border-collapse:collapse;font-size:12px}
.wbc-table th{text-align:left;font-weight:500;color:var(--dsw-alias-label-secondary);padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.wbc-table td{padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.wbc-table tr:last-child td{border-bottom:0}
.wbc-num{text-align:right}
.wbc-pos{color:var(--dsw-alias-label-success,#30a46c)}
.wbc-neg{color:var(--dsw-alias-label-error,#e5484d)}
.wbc-spark{display:flex;align-items:flex-end;gap:2px;height:40px}
.wbc-spark-bar{flex:1;min-width:2px;background:var(--dsw-alias-label-primary);opacity:.35;border-radius:1px 1px 0 0}
.wbc-spark-bar-on{opacity:.9}
`;

  function ensureCss() {
    if (typeof document === 'undefined') return;
    if (document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) !== null) return;
    const tag = document.createElement('style');
    tag.dataset.plugin = 'dsh-workbuddy-console';
    tag.dataset.pluginCss = CSS_ID;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  async function fetchJson(url, init) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      ...init,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* 非 JSON 响应 */
    }
    if (!res.ok) {
      const msg = body?.error ?? body?.message ?? `HTTP ${res.status}`;
      throw new Error(String(msg));
    }
    return body;
  }

  /**
   * 取数组字段。
   *
   * 不能写 `x ?? []`：`??` 只挡 null/undefined，接口若返回字符串或对象
   * 就会漏过去，随后 `.map` / `.reduce` 抛错 —— 而渲染期抛错会让整个
   * 设置面板白屏。接口返回值不可信，统一用这个收口。
   */
  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }

  function fmtNum(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
    return n.toLocaleString('en-US');
  }

  function fmtTime(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '–';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtRelative(ts) {
    if (typeof ts !== 'number' || ts <= 0) return '–';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  //#region 账号页
  function AccountsTab({ region, onRegion, status, loading, error, onRescan, onCheckin, busyId }) {
    const accounts = asArray(status?.accounts);
    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-bar',
          children: [
            jsx('button', {
              type: 'button',
              className: region === 'cn' ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
              onClick: () => onRegion('cn'),
              children: '国内版',
            }),
            jsx('button', {
              type: 'button',
              className: region === 'global' ? 'wbc-btn wbc-btn-primary' : 'wbc-btn',
              onClick: () => onRegion('global'),
              children: '国际版',
            }),
            jsx('div', { className: 'wbc-spacer' }),
            jsx('button', {
              type: 'button',
              className: 'wbc-btn',
              disabled: loading,
              onClick: onRescan,
              children: loading ? '检测中…' : '重新检测本机账号',
            }),
          ],
        }),
        error !== null
          ? jsx('div', { className: 'wbc-err', children: `读取失败：${error}` })
          : null,
        accounts.length === 0
          ? jsx('div', {
              className: 'wbc-empty',
              children: [
                jsx('div', { children: '这边还没有检测到已登录的 WorkBuddy 账号。' }),
                jsx('div', {
                  children: '请在 WorkBuddy 桌面版里登录，然后点上面的「重新检测本机账号」。',
                }),
              ],
            })
          : jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsxs(
                  'div',
                  {
                    className: a.cooling || a.disabled ? 'wbc-card wbc-card-off' : 'wbc-card',
                    children: [
                      jsxs('div', {
                        className: 'wbc-card-head',
                        children: [
                          jsx('span', { className: 'wbc-name', children: a.nickname || a.label || a.id }),
                          a.cooling
                            ? jsx('span', { className: 'wbc-tag wbc-tag-warn', children: '冷却中' })
                            : jsx('span', { className: 'wbc-tag wbc-tag-on', children: '正常' }),
                          a.disabled ? jsx('span', { className: 'wbc-tag', children: '已停用' }) : null,
                        ],
                      }),
                      jsxs('div', {
                        className: 'wbc-kv',
                        children: [
                          jsx('span', { className: 'wbc-k', children: '额度' }),
                          jsx('span', { className: 'wbc-v', children: fmtNum(a.credits?.total) }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'wbc-kv',
                        children: [
                          jsx('span', { className: 'wbc-k', children: '签到' }),
                          jsx('span', {
                            className: 'wbc-v',
                            children:
                              a.checkin === undefined
                                ? a.checkinError
                                  ? '不可用'
                                  : '–'
                                : a.checkin.todayCheckedIn
                                  ? `今日已签 · 连签 ${a.checkin.streakDays ?? 0} 天`
                                  : `未签到 · 连签 ${a.checkin.streakDays ?? 0} 天`,
                          }),
                        ],
                      }),
                      a.expiresAt
                        ? jsxs('div', {
                            className: 'wbc-kv',
                            children: [
                              jsx('span', { className: 'wbc-k', children: '令牌到期' }),
                              jsx('span', { className: 'wbc-v', children: fmtTime(Date.parse(a.expiresAt)) }),
                            ],
                          })
                        : null,
                      jsx('button', {
                        type: 'button',
                        className: 'wbc-btn',
                        disabled: busyId === a.id || a.cooling === true,
                        onClick: () => onCheckin(a.id),
                        children: busyId === a.id ? '签到中…' : '签到领取',
                      }),
                    ],
                  },
                  a.id,
                ),
              ),
            }),
      ],
    });
  }
  //#endregion

  //#region 积分页
  function CreditsTab({ status, summary, loading }) {
    const accounts = asArray(status?.accounts);
    const rows = asArray(summary?.accounts);
    const liveTotal = accounts.reduce(
      (sum, a) => sum + (typeof a.credits?.total === 'number' ? a.credits.total : 0),
      0,
    );
    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-cards',
          children: [
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '当前总积分' }),
                jsx('div', { className: 'wbc-sum-value', children: fmtNum(liveTotal) }),
                jsx('div', {
                  className: 'wbc-sum-sub',
                  children: `${accounts.length} 个账号`,
                }),
              ],
            }),
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '采样记录' }),
                jsx('div', { className: 'wbc-sum-value', children: fmtNum(summary?.totalSamples ?? 0) }),
                jsx('div', { className: 'wbc-sum-sub', children: '条积分快照' }),
              ],
            }),
            jsxs('div', {
              className: 'wbc-sum',
              children: [
                jsx('div', { className: 'wbc-sum-label', children: '历史跨度' }),
                jsx('div', {
                  className: 'wbc-sum-value',
                  children: loading ? '…' : `${summary?.dailyTrend?.length ?? 0} 天`,
                }),
                jsx('div', { className: 'wbc-sum-sub', children: '按天统计' }),
              ],
            }),
          ],
        }),
        accounts.length === 0
          ? jsx('div', { className: 'wbc-empty', children: '暂无账号数据。' })
          : jsx('div', {
              className: 'wbc-cards',
              children: accounts.map((a) =>
                jsxs(
                  'div',
                  {
                    className: 'wbc-card',
                    children: [
                      jsxs('div', {
                        className: 'wbc-card-head',
                        children: [
                          jsx('span', { className: 'wbc-name', children: a.nickname || a.label || a.id }),
                        ],
                      }),
                      jsxs('div', {
                        className: 'wbc-kv',
                        children: [
                          jsx('span', { className: 'wbc-k', children: '总额' }),
                          jsx('span', { className: 'wbc-v', children: fmtNum(a.credits?.total) }),
                        ],
                      }),
                      asArray(a.credits?.packages).length > 0
                        ? jsx('div', {
                            className: 'wbc-packs',
                            children: asArray(a.credits?.packages)
                              .filter((p) => (p.size ?? 0) > 0)
                              .slice(0, 6)
                              .map((p, i) =>
                                jsxs(
                                  'div',
                                  {
                                    className: 'wbc-pack',
                                    children: [
                                      jsx('span', { className: 'wbc-pack-name', children: p.packageName ?? '–' }),
                                      jsx('span', {
                                        className: 'wbc-pack-val',
                                        children: `${fmtNum(p.remain)} / ${fmtNum(p.size)}`,
                                      }),
                                    ],
                                  },
                                  `${p.packageName ?? 'p'}-${i}`,
                                ),
                              ),
                          })
                        : jsx('div', { className: 'wbc-note', children: '无积分包明细' }),
                      a.creditsError ? jsx('div', { className: 'wbc-err', children: a.creditsError }) : null,
                    ],
                  },
                  a.id,
                ),
              ),
            }),
      ],
    });
  }
  //#endregion

  //#region 使用记录页
  function HistoryTab({ summary, loading }) {
    const trend = asArray(summary?.dailyTrend);
    const rows = asArray(summary?.accounts);
    const maxAbs = trend.reduce((m, d) => Math.max(m, Math.abs(d.delta)), 0) || 1;

    return jsxs('div', {
      className: 'wbc-body',
      children: [
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: '每日净变化' }),
            jsx('div', {
              className: 'wbc-desc',
              children: '同一天内最后观测值减去最初观测值；正数是当天入账，负数是当天消耗。',
            }),
          ],
        }),
        trend.length === 0
          ? jsx('div', {
              className: 'wbc-empty',
              children: loading ? '正在读取…' : '还没有采样记录。打开本页时会自动采集一次当前额度。',
            })
          : jsxs('div', {
              className: 'wbc-table-wrap',
              children: [
                jsxs('div', { className: 'wbc-spark', style: { padding: '12px' } ,
                  children: trend.slice(-40).map((d, i) =>
                    jsx('div', {
                      className: 'wbc-spark-bar wbc-spark-bar-on',
                      style: { height: `${Math.max(2, (Math.abs(d.delta) / maxAbs) * 36)}px` },
                      title: `${d.day}: ${d.delta >= 0 ? '+' : ''}${d.delta}`,
                    }, `${d.day}-${i}`),
                  ),
                }),
                jsxs('table', {
                  className: 'wbc-table',
                  children: [
                    jsx('thead', {
                      children: jsxs('tr', {
                        children: [
                          jsx('th', { children: '日期' }),
                          jsx('th', { className: 'wbc-num', children: '净变化' }),
                        ],
                      }),
                    }),
                    jsx('tbody', {
                      children: trend
                        .slice()
                        .reverse()
                        .map((d) =>
                          jsxs(
                            'tr',
                            {
                              children: [
                                jsx('td', { children: d.day }),
                                jsx('td', {
                                  className: d.delta > 0 ? 'wbc-num wbc-pos' : d.delta < 0 ? 'wbc-num wbc-neg' : 'wbc-num',
                                  children: `${d.delta >= 0 ? '+' : ''}${fmtNum(d.delta)}`,
                                }),
                              ],
                            },
                            d.day,
                          ),
                        ),
                    }),
                  ],
                }),
              ],
            }),
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: '账号明细' }),
            jsx('div', {
              className: 'wbc-desc',
              children: '首次观测与最新观测的对比。',
            }),
          ],
        }),
        rows.length === 0
          ? jsx('div', { className: 'wbc-empty', children: '暂无记录。' })
          : jsx('div', {
              className: 'wbc-table-wrap',
              children: jsxs('table', {
                className: 'wbc-table',
                children: [
                  jsx('thead', {
                    children: jsxs('tr', {
                      children: [
                        jsx('th', { children: '账号' }),
                        jsx('th', { className: 'wbc-num', children: '首次' }),
                        jsx('th', { className: 'wbc-num', children: '最新' }),
                        jsx('th', { className: 'wbc-num', children: '变化' }),
                        jsx('th', { children: '最近观测' }),
                      ],
                    }),
                  }),
                  jsx('tbody', {
                    children: rows.map((r) =>
                      jsxs(
                        'tr',
                        {
                          children: [
                            jsx('td', { children: r.nickname || r.uid }),
                            jsx('td', { className: 'wbc-num', children: fmtNum(r.firstCredit) }),
                            jsx('td', { className: 'wbc-num', children: fmtNum(r.credit) }),
                            jsx('td', {
                              className: r.delta > 0 ? 'wbc-num wbc-pos' : r.delta < 0 ? 'wbc-num wbc-neg' : 'wbc-num',
                              children: `${r.delta >= 0 ? '+' : ''}${fmtNum(r.delta)}`,
                            }),
                            jsx('td', { title: fmtTime(r.lastTs), children: fmtRelative(r.lastTs) }),
                          ],
                        },
                        r.uid,
                      ),
                    ),
                  }),
                ],
              }),
            }),
      ],
    });
  }
  //#endregion

  /** 设置页主组件。props 来自 slots 契约：{ close, ...inject 的返回值 } */
  function WorkBuddyPage(props) {
    ensureCss();

    const [tab, setTab] = useState('accounts');
    const [region, setRegion] = useState('cn');
    const [status, setStatus] = useState(null);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [summaryLoading, setSummaryLoading] = useState(true);
    const [error, setError] = useState(null);
    const [busyId, setBusyId] = useState(null);

    const loadStatus = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson(`${POOL_API}/status?region=${region}`);
        setStatus(data);
      } catch (e) {
        setError(e?.message ?? String(e));
      } finally {
        setLoading(false);
      }
    }, [region]);

    const loadSummary = useCallback(async () => {
      setSummaryLoading(true);
      try {
        const data = await fetchJson(`${SELF_API}/history-summary`);
        setSummary(data);
      } catch {
        /* 历史记录读不到不影响其它 tab */
      } finally {
        setSummaryLoading(false);
      }
    }, []);

    // 首次进页 + 切换区域时拉取；同时把当前状态回写一份采样
    useEffect(() => {
      loadStatus();
    }, [loadStatus]);

    useEffect(() => {
      loadSummary();
    }, [loadSummary]);

    // 拿到最新 status 后落一次采样，让「使用记录」持续增长。
    // 放在这里而不是定时器：只在用户真的打开本页时采集，不做后台轮询。
    useEffect(() => {
      if (status === null || !Array.isArray(status.accounts)) return;
      fetch(`${SELF_API}/sample`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region }),
      })
        .then(() => loadSummary())
        .catch(() => {});
    }, [status, region, loadSummary]);

    const onRescan = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        await fetchJson(`${POOL_API}/accounts/rescan`, { method: 'POST' });
        await loadStatus();
      } catch (e) {
        setError(e?.message ?? String(e));
        setLoading(false);
      }
    }, [loadStatus]);

    const onCheckin = useCallback(
      async (accountId) => {
        setBusyId(accountId);
        try {
          await fetchJson(`${POOL_API}/checkin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ accountId }),
          });
          await loadStatus();
        } catch (e) {
          setError(e?.message ?? String(e));
        } finally {
          setBusyId(null);
        }
      },
      [loadStatus],
    );

    const tabs = [
      { id: 'accounts', label: '账号' },
      { id: 'credits', label: '积分' },
      { id: 'history', label: '使用记录' },
    ];

    return jsxs('div', {
      className: 'wbc-page',
      children: [
        jsxs('div', {
          className: 'wbc-head',
          children: [
            jsx('div', { className: 'wbc-title', children: 'WorkBuddy 管理' }),
            jsx('div', {
              className: 'wbc-desc',
              children:
                '查看本机已登录的 WorkBuddy 账号、额度与使用记录。账号登录请在本机 WorkBuddy 桌面版完成，本页只读取它的登录状态。',
            }),
          ],
        }),
        jsx('div', {
          className: 'wbc-tabs',
          children: tabs.map((x) =>
            jsx(
              'button',
              {
                type: 'button',
                className: tab === x.id ? 'wbc-tab wbc-tab-on' : 'wbc-tab',
                onClick: () => setTab(x.id),
                children: x.label,
              },
              x.id,
            ),
          ),
        }),
        tab === 'accounts'
          ? jsx(AccountsTab, {
              region,
              onRegion: setRegion,
              status,
              loading,
              error,
              onRescan,
              onCheckin,
              busyId,
            })
          : null,
        tab === 'credits' ? jsx(CreditsTab, { status, summary, loading }) : null,
        tab === 'history' ? jsx(HistoryTab, { summary, loading: summaryLoading }) : null,
      ],
    });
  }

  return WorkBuddyPage;
}
