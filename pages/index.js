import { useState, useEffect, useCallback, useRef } from 'react';
import Head from 'next/head';

const N8N_ANALYZE = process.env.NEXT_PUBLIC_N8N_ANALYZE;
const N8N_GET     = process.env.NEXT_PUBLIC_N8N_GET;
const N8N_DELETE  = process.env.NEXT_PUBLIC_N8N_DELETE;
const N8N_TRACK   = process.env.NEXT_PUBLIC_N8N_TRACK;

const SENT = {
  positive: { bg: 'rgba(16,185,129,0.12)', text: '#10b981', dot: '#10b981', glow: '0 0 8px rgba(16,185,129,0.4)' },
  neutral:  { bg: 'rgba(234,179,8,0.12)',  text: '#eab308', dot: '#eab308', glow: '0 0 8px rgba(234,179,8,0.4)'  },
  negative: { bg: 'rgba(239,68,68,0.12)',  text: '#ef4444', dot: '#ef4444', glow: '0 0 8px rgba(239,68,68,0.4)'  },
};

const TRACK_TYPES = [
  { id: 'title',    icon: '◈', label: 'Article Title',  placeholder: 'Enter the exact article title or headline...' },
  { id: 'keywords', icon: '⌖', label: 'Keywords',       placeholder: 'Enter keywords from the press release...' },
  { id: 'hashtag',  icon: '#', label: 'Hashtag',        placeholder: '#YourHashtag' },
  { id: 'document', icon: '≡', label: 'Press Release',  placeholder: 'Paste the full press release text here...' },
];

function TextModal({ title, text, onClose }) {
  const ref = useRef();
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div className="modal-overlay">
      <div className="modal-box" ref={ref}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <p className="modal-body">{text}</p>
      </div>
    </div>
  );
}

export default function Home() {
  const [articles,   setArticles]   = useState([]);
  const [url,        setUrl]        = useState('');
  const [loading,    setLoading]    = useState(false);
  const [fetching,   setFetching]   = useState(true);
  const [filter,     setFilter]     = useState('all');
  const [error,      setError]      = useState('');
  const [success,    setSuccess]    = useState('');
  const [modal,      setModal]      = useState(null);
  const [menuOpen,   setMenuOpen]   = useState(false);
  const [activeTab,  setActiveTab]  = useState('track');
  const [trackType,  setTrackType]  = useState('title');
  const [trackQuery, setTrackQuery] = useState('');
  const [tracking,   setTracking]   = useState(false);
  const [trackMsg,   setTrackMsg]   = useState('');
  const [expandedGroups, setExpandedGroups] = useState({});

  const toggleGroup = (group) => {
    setExpandedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const fetchArticles = useCallback(async () => {
    try {
      const res  = await fetch(N8N_GET);
      const data = await res.json();
      const raw = data.articles || data || [];
      const list = Array.isArray(raw) ? raw : [];
      const valid = list.filter(a =>
        a.url && a.publication && a.publication !== 'Unknown' && a.publication.trim() !== ''
      );
      if (valid.length > 0) {
        setArticles(valid);
      }
      // If n8n returns only _ids (no article data), keep existing articles in state
    } catch (e) { console.error('fetchArticles error:', e); }
    finally { setFetching(false); }
  }, []);

  useEffect(() => { fetchArticles(); }, [fetchArticles]);

  async function analyze() {
    if (!url.trim()) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const res = await fetch(N8N_ANALYZE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() }),
      });
      if (!res.ok) throw new Error();
      const article = await res.json();
      setArticles(prev => [{ ...article, _id: article._id || Date.now().toString() }, ...prev]);
      setUrl('');
      setSuccess('Article analyzed and saved!');
      setTimeout(() => setSuccess(''), 4000);
    } catch { setError('Analysis failed. Check the URL and try again.'); }
    finally { setLoading(false); }
  }

  async function trackCoverage() {
    if (!trackQuery.trim()) return;
    setTracking(true); setError(''); setSuccess('');
    const msgs = [
      'Searching Google for coverage via Serper…',
      'Scanning news outlets and websites…',
      'Finding all publications…',
      'Analyzing each article with AI…',
      'Extracting sentiment & PR insights…',
      'Saving results to dashboard…',
    ];
    let i = 0;
    setTrackMsg(msgs[0]);
    const interval = setInterval(() => { i = (i + 1) % msgs.length; setTrackMsg(msgs[i]); }, 5000);
    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ searchType: trackType, query: trackQuery.trim() }),
      });
      clearInterval(interval);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Tracking failed');
      }
      const data = await res.json();
      setTrackQuery('');
      setTrackMsg('');
      
      // Directly add the analyzed articles to the dashboard
      // (since n8n GET endpoint only returns _ids, not full data)
      if (data.results && data.results.length > 0) {
        const newArticles = data.results
          .filter(a => a && a.url && a.publication)
          .map(a => ({ ...a, _id: a._id || Date.now().toString() + Math.random() }));
        setArticles(prev => {
          // Merge: add new articles that don't already exist
          const existingUrls = new Set(prev.map(p => p.url));
          const unique = newArticles.filter(a => !existingUrls.has(a.url));
          return [...unique, ...prev];
        });
      }
      
      if (data.articlesFound === 0) {
        setSuccess('No coverage found for this search. Try different keywords or a broader search.');
      } else {
        setSuccess(`Found ${data.articlesFound} publications — ${data.articlesAnalyzed} articles analyzed & saved!`);
      }
      setTimeout(() => setSuccess(''), 8000);
    } catch (err) {
      clearInterval(interval);
      setTrackMsg('');
      setError(err.message || 'Tracking failed. Try different keywords or check the connection.');
    }
    finally { setTracking(false); }
  }

  async function deleteArticle(id) {
    if (!confirm('Remove this article?')) return;
    try {
      await fetch(N8N_DELETE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      setArticles(prev => prev.filter(a => String(a._id) !== String(id)));
    } catch { alert('Delete failed.'); }
  }

  function exportCSV() {
    const h = ['URL','Publication','Readership','Sentiment','Summary','Next Action','Tags','Date'];
    const rows = filtered.map(a => [
      a.url,''+a.publication,''+a.readership,''+a.sentiment,
      '"'+(a.summary||'').replace(/"/g,'""')+'"',
      '"'+(a.next_action||'').replace(/"/g,'""')+'"',
      (a.tags||[]).join('; '),
      a.created_at ? new Date(a.created_at).toLocaleDateString() : '',
    ]);
    const csv  = [h,...rows].map(r=>r.join(',')).join('\n');
    const link = document.createElement('a');
    link.href     = URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
    link.download = `pr-tracker-${new Date().toISOString().slice(0,10)}.csv`;
    link.click();
  }

  const filtered   = filter === 'all' ? articles : articles.filter(a => a.sentiment === filter);
  const posCount   = articles.filter(a => a.sentiment === 'positive').length;
  const posPct     = articles.length ? Math.round(posCount/articles.length*100) : 0;
  const outlets    = [...new Set(articles.map(a=>a.publication).filter(Boolean))].length;
  const totalReach = articles.reduce((s,a)=>{
    const r=String(a.readership||''), n=parseFloat(r);
    if(isNaN(n)) return s;
    return s+(r.toUpperCase().includes('M')?n*1e6:r.toUpperCase().includes('K')?n*1e3:n);
  },0);
  const reach = totalReach>=1e6?(totalReach/1e6).toFixed(1)+'M':totalReach>=1e3?Math.round(totalReach/1e3)+'K':totalReach>0?''+totalReach:'—';
  const currentTrackType = TRACK_TYPES.find(t => t.id === trackType);

  const groupedArticles = filtered.reduce((acc, a) => {
    const group = a.search_query || 'Direct Analysis / Legacy';
    if (!acc[group]) acc[group] = [];
    acc[group].push(a);
    return acc;
  }, {});

  return (
    <>
      <Head>
        <title>PR Article Tracker</title>
        <meta name="viewport" content="width=device-width,initial-scale=1"/>
        <link rel="preconnect" href="https://fonts.googleapis.com"/>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet"/>
      </Head>

      <div className="root">
        {/* Mobile Header */}
        <div className="mobile-header">
          <button className="hamburger" onClick={()=>setMenuOpen(!menuOpen)} aria-label="Toggle menu">
            <span className={`hamburger-line${menuOpen?' open':''}`}/>
            <span className={`hamburger-line${menuOpen?' open':''}`}/>
            <span className={`hamburger-line${menuOpen?' open':''}`}/>
          </button>
          <div className="mobile-logo">
            <div className="logo-icon">PR</div>
            <span className="logo-text">Tracker</span>
          </div>
          <div style={{width:'32px'}}/>
        </div>

        {menuOpen && <div className="sidebar-overlay" onClick={()=>setMenuOpen(false)}/>}

        {/* Sidebar */}
        <aside className={`sidebar${menuOpen?' open':''}`}>
          <div className="logo">
            <div className="logo-icon">PR</div>
            <span className="logo-text">Tracker</span>
          </div>
          <nav className="nav">
            <a className="nav-item active" href="#" onClick={()=>setMenuOpen(false)}>
              <span className="nav-icon">▦</span> Dashboard
            </a>
            <a className="nav-item" href="#" onClick={e=>{e.preventDefault();setMenuOpen(false);}}>
              <span className="nav-icon">◈</span> Articles
            </a>
            <a className="nav-item" href="#" onClick={e=>{e.preventDefault();setMenuOpen(false);}}>
              <span className="nav-icon">◎</span> Analytics
            </a>
            <a className="nav-item" href="#" onClick={e=>{e.preventDefault();setMenuOpen(false);}}>
              <span className="nav-icon">⊕</span> Settings
            </a>
          </nav>
          <div className="sidebar-footer">
            <div className="ai-badge">
              <span className="ai-dot"/>
              <span>AI Powered</span>
            </div>
            <p className="sidebar-sub">n8n · OpenAI · MongoDB</p>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="topbar">
            <div>
              <h1 className="page-title">PR Coverage Dashboard</h1>
              <p className="page-sub">Track, analyze and measure your media coverage with AI</p>
            </div>
            <button className="export-btn" onClick={exportCSV} disabled={filtered.length===0}>
              <span>↓</span> Export CSV
            </button>
          </div>

          {/* Metrics */}
          <div className="metrics">
            {[
              { label:'Total Articles',    value: articles.length, icon:'◈', color:'#6366f1', grad:'135deg,#6366f1,#8b5cf6' },
              { label:'Positive Coverage', value: posPct+'%',      icon:'↑', color:'#10b981', grad:'135deg,#10b981,#059669' },
              { label:'Unique Outlets',    value: outlets,          icon:'◎', color:'#f59e0b', grad:'135deg,#f59e0b,#d97706' },
              { label:'Estimated Reach',   value: reach,            icon:'◉', color:'#3b82f6', grad:'135deg,#3b82f6,#2563eb' },
            ].map(m=>(
              <div key={m.label} className="metric-card">
                <div className="metric-icon-wrap" style={{background:`linear-gradient(${m.grad})`}}>
                  <span className="metric-icon">{m.icon}</span>
                </div>
                <div className="metric-body">
                  <div className="metric-value" style={{color:m.color}}>{m.value}</div>
                  <div className="metric-label">{m.label}</div>
                </div>
                <div className="metric-glow" style={{background:`radial-gradient(circle at 80% 50%,${m.color}18,transparent 70%)`}}/>
              </div>
            ))}
          </div>

          {/* Action Card */}
          <div className="action-card">
            <div className="tab-group">
              <button
                className={`tab-btn${activeTab==='track'?' active':''}`}
                onClick={()=>{ setActiveTab('track'); setError(''); setSuccess(''); }}
              >
                <span>◎</span> Track Coverage
              </button>
              <button
                className={`tab-btn${activeTab==='analyze'?' active':''}`}
                onClick={()=>{ setActiveTab('analyze'); setError(''); setSuccess(''); }}
              >
                <span>🔗</span> Analyze URL
              </button>
            </div>

            {/* Tab: Analyze URL */}
            {activeTab === 'analyze' && (
              <div className="tab-body">
                <p className="tab-hint">Paste any article URL — AI will extract publication, sentiment &amp; PR insights</p>
                <div className="input-row">
                  <div className="input-wrap">
                    <span className="input-icon">🔗</span>
                    <input
                      className="url-input"
                      type="url"
                      placeholder="https://forbes.com/sites/your-article-title"
                      value={url}
                      onChange={e=>setUrl(e.target.value)}
                      onKeyDown={e=>e.key==='Enter'&&!loading&&analyze()}
                      disabled={loading}
                    />
                  </div>
                  <button className={`action-btn${loading?' loading':''}`} onClick={analyze} disabled={loading}>
                    {loading ? <><span className="spinner"/>Analyzing…</> : <><span>✦</span>Analyze</>}
                  </button>
                </div>
                {loading && <div className="progress-track"><div className="progress-fill"/></div>}
                {error   && <div className="msg err">{error}</div>}
                {success && <div className="msg ok">✓ {success}</div>}
              </div>
            )}

            {/* Tab: Track Coverage */}
            {activeTab === 'track' && (
              <div className="tab-body">
                <p className="tab-hint">Find all publications of a press release across the web — choose how you want to search</p>

                <div className="track-types">
                  {TRACK_TYPES.map(t => (
                    <button
                      key={t.id}
                      className={`track-type-btn${trackType===t.id?' active':''}`}
                      onClick={()=>{ setTrackType(t.id); setTrackQuery(''); }}
                      disabled={tracking}
                    >
                      <span className="track-icon">{t.icon}</span>
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="track-input-area">
                  {trackType === 'document' ? (
                    <textarea
                      className="track-textarea"
                      placeholder={currentTrackType.placeholder}
                      value={trackQuery}
                      onChange={e=>setTrackQuery(e.target.value)}
                      disabled={tracking}
                      rows={5}
                    />
                  ) : (
                    <div className="input-row">
                      <div className="input-wrap">
                        <span className="input-icon" style={{fontSize:'12px'}}>{currentTrackType.icon}</span>
                        <input
                          className="url-input"
                          type="text"
                          placeholder={currentTrackType.placeholder}
                          value={trackQuery}
                          onChange={e=>setTrackQuery(e.target.value)}
                          onKeyDown={e=>e.key==='Enter'&&!tracking&&trackCoverage()}
                          disabled={tracking}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="track-footer">
                  {tracking && trackMsg && (
                    <div className="track-status">
                      <span className="spinner" style={{borderTopColor:'#a5b4fc'}}/>
                      <span>{trackMsg}</span>
                    </div>
                  )}
                  <button
                    className={`action-btn${tracking?' loading':''}`}
                    onClick={trackCoverage}
                    disabled={tracking || !trackQuery.trim()}
                    style={{background:'linear-gradient(135deg,#0ea5e9,#6366f1)'}}
                  >
                    {tracking
                      ? <><span className="spinner"/>Searching…</>
                      : <><span>◎</span>Find All Coverage</>
                    }
                  </button>
                </div>

                {error   && <div className="msg err">{error}</div>}
                {success && <div className="msg ok">✓ {success}</div>}
              </div>
            )}
          </div>

          {/* Table */}
          <div className="table-section">
            <div className="table-header">
              <div className="filter-group">
                {articles.length > 0 && ['all','positive','neutral','negative'].map(f=>{
                  const active = filter===f;
                  const sc = SENT[f];
                  const count = f==='all'?articles.length:articles.filter(a=>a.sentiment===f).length;
                  return (
                    <button
                      key={f}
                      onClick={()=>setFilter(f)}
                      className={`filter-btn${active?' active':''}`}
                      data-sentiment={f}
                    >
                      {sc && <span className="f-dot" style={{background:sc.dot}}/>}
                      {f.charAt(0).toUpperCase()+f.slice(1)}
                      <span className="f-count">{count}</span>
                    </button>
                  );
                })}
              </div>
              {articles.length > 0 && <span className="table-count">{filtered.length} article{filtered.length!==1?'s':''}</span>}
            </div>

            <div className="table-wrap">
              {fetching ? (
                <div className="empty-state">
                  <div className="empty-spinner"/>
                  <p>Loading articles…</p>
                </div>
              ) : filtered.length===0 ? (
                <div className="empty-state">
                  <div className="empty-icon">◈</div>
                  <p>{filter!=='all'?`No ${filter} articles found.`:'No articles yet — analyze a URL or track press release coverage above.'}</p>
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      {['Publication','Readership','Sentiment','PR Summary','Next Action','Tags','Date',''].map(h=>(
                        <th key={h} className="th">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  {Object.entries(groupedArticles).map(([group, groupArticles]) => {
                    const isExpanded = expandedGroups[group] !== false; // default true
                    return (
                      <tbody key={group}>
                        <tr onClick={() => toggleGroup(group)} style={{cursor: 'pointer', background: 'rgba(255,255,255,0.02)'}}>
                          <td colSpan="8" style={{fontWeight: '500', padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)', color: '#e2e8f0'}}>
                            <span style={{display: 'inline-block', width: '20px'}}>{isExpanded ? '▼' : '▶'}</span>
                            Results for: <span style={{color: '#818cf8'}}>{group}</span> <span style={{color: '#94a3b8', fontSize: '0.9em'}}>({groupArticles.length})</span>
                          </td>
                        </tr>
                        {isExpanded && groupArticles.map((a,i)=>{
                          const sc = SENT[a.sentiment]||SENT.neutral;
                          return (
                            <tr key={String(a._id)||i} className="tr">
                              <td className="td">
                                <a href={a.url} target="_blank" rel="noreferrer" className="pub-link">
                                  <span className="pub-avatar">{(a.publication||'?')[0]}</span>
                                  {a.publication||'Unknown'}
                                </a>
                              </td>
                              <td className="td reach-td">{a.readership||'—'}</td>
                              <td className="td">
                                <span className="sent-badge" style={{background:sc.bg,color:sc.text,boxShadow:sc.glow}}>
                                  <span className="sent-dot" style={{background:sc.dot}}/>
                                  {a.sentiment||'neutral'}
                                </span>
                              </td>
                              <td className="td summary-td">
                                {a.summary
                                  ? <span className="clamp clamp-click" onClick={()=>setModal({title:'PR Summary',text:a.summary})}>{a.summary}</span>
                                  : <span>—</span>}
                              </td>
                              <td className="td action-td">
                                {a.next_action
                                  ? <span className="clamp clamp-click" onClick={()=>setModal({title:'Next Action',text:a.next_action})}>{a.next_action}</span>
                                  : <span>—</span>}
                              </td>
                              <td className="td">
                                <div className="tags">
                                  {(a.tags||[]).slice(0,3).map(t=>(
                                    <span key={t} className="tag">{t}</span>
                                  ))}
                                </div>
                              </td>
                              <td className="td date-td">
                                {a.created_at?new Date(a.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—'}
                              </td>
                              <td className="td">
                                <button className="del-btn" onClick={()=>deleteArticle(String(a._id))} title="Delete">✕</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    );
                  })}
                </table>
              )}
            </div>
          </div>
        </main>
      </div>

      {modal && <TextModal title={modal.title} text={modal.text} onClose={()=>setModal(null)}/>}
    </>
  );
}
