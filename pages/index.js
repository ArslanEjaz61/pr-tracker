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
  { id: 'image',    icon: '📷', label: 'Upload Image',   placeholder: 'Upload a screenshot or photo of the article...' },
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
  
  const [selectedTypes, setSelectedTypes] = useState(['title']);
  const [titleQuery, setTitleQuery] = useState('');
  const [keywordsQuery, setKeywordsQuery] = useState('');
  const [hashtagQuery, setHashtagQuery] = useState('');
  const [documentQuery, setDocumentQuery] = useState('');

  const [tracking,   setTracking]   = useState(false);
  const [trackMsg,   setTrackMsg]   = useState('');
  const [expandedGroups, setExpandedGroups] = useState({});
  const [activePage, setActivePage] = useState('dashboard');

  const [imageFile,    setImageFile]    = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [ocrLoading,   setOcrLoading]   = useState(false);
  const [ocrResult,    setOcrResult]    = useState(null);
  const [ocrError,     setOcrError]     = useState('');

  const fileInputRef = useRef(null);

  const handleImageUpload = (file) => {
    if (!file || !file.type.startsWith('image/')) {
      setOcrError('Please upload an image file (PNG, JPG, or JPEG).');
      return;
    }
    setImageFile(file);
    setOcrError('');
    setOcrResult(null);
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const base64Data = e.target.result;
      setImagePreview(base64Data);
      setOcrLoading(true);
      
      try {
        const response = await fetch('/api/ocr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: base64Data })
        });
        
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to scan image');
        }
        
        setOcrResult({
          title: data.title || '',
          keywords: data.keywords || '',
        });
      } catch (err) {
        console.error('OCR Error:', err);
        setOcrError(err.message || 'Failed to process image. Make sure your API key is correct.');
      } finally {
        setOcrLoading(false);
      }
    };
    reader.readAsDataURL(file);
  };

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

  useEffect(() => {
    const handlePaste = (e) => {
      if (activePage !== 'dashboard' || activeTab !== 'track' || !selectedTypes.includes('image')) return;
      
      const items = e.clipboardData?.items;
      if (!items) return;
      
      for (const item of items) {
        if (item.type.indexOf('image') !== -1) {
          const file = item.getAsFile();
          if (file) {
            handleImageUpload(file);
            break;
          }
        }
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activePage, activeTab, selectedTypes, handleImageUpload]);

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
    const targets = [];
    if (selectedTypes.includes('title') && titleQuery.trim()) {
      targets.push({ type: 'title', query: titleQuery.trim() });
    }
    if (selectedTypes.includes('keywords') && keywordsQuery.trim()) {
      targets.push({ type: 'keywords', query: keywordsQuery.trim() });
    }
    if (selectedTypes.includes('hashtag') && hashtagQuery.trim()) {
      targets.push({ type: 'hashtag', query: hashtagQuery.trim() });
    }
    if (selectedTypes.includes('document') && documentQuery.trim()) {
      targets.push({ type: 'document', query: documentQuery.trim() });
    }
    if (selectedTypes.includes('image') && ocrResult) {
      if (ocrResult.title) {
        targets.push({ type: 'title', query: ocrResult.title });
      }
      if (ocrResult.keywords) {
        targets.push({ type: 'keywords', query: ocrResult.keywords });
      }
    }

    if (targets.length === 0) return;

    setTracking(true); setError(''); setSuccess('');
    setTrackMsg('Connecting to tracking server...');
    
    try {
      const res = await fetch('/api/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets }),
      });
      
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Tracking failed');
      }
      
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let doneReading = false;
      let finalData = null;
      let buffer = '';

      while (!doneReading) {
        const { value, done } = await reader.read();
        doneReading = done;
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || ''; // Keep incomplete chunk in buffer
          
          for (const part of parts) {
            if (part.startsWith('data: ')) {
              try {
                const parsed = JSON.parse(part.substring(6));
                if (parsed.type === 'progress') {
                  setTrackMsg(parsed.message);
                } else if (parsed.type === 'done') {
                  finalData = parsed;
                } else if (parsed.type === 'error') {
                  throw new Error(parsed.error || 'Tracking failed');
                }
              } catch (e) {
                console.error("SSE parse error", e);
              }
            }
          }
        }
      }

      if (!finalData) throw new Error('Incomplete response from server');
      const data = finalData;
      
      // Clear all active inputs
      setTitleQuery('');
      setKeywordsQuery('');
      setHashtagQuery('');
      setDocumentQuery('');
      setImageFile(null);
      setImagePreview(null);
      setOcrResult(null);
      setOcrError('');
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
  const currentTrackType = TRACK_TYPES.find(t => t.id === selectedTypes[0]) || TRACK_TYPES[0];

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
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
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
            <a className={`nav-item ${activePage==='dashboard'?'active':''}`} href="#" onClick={(e)=>{e.preventDefault();setActivePage('dashboard');setMenuOpen(false);}}>
              <span className="nav-icon">▦</span> Dashboard
            </a>
            <a className={`nav-item ${activePage==='articles'?'active':''}`} href="#" onClick={(e)=>{e.preventDefault();setActivePage('articles');setMenuOpen(false);}}>
              <span className="nav-icon">◈</span> Articles
            </a>
            <a className={`nav-item ${activePage==='analytics'?'active':''}`} href="#" onClick={(e)=>{e.preventDefault();setActivePage('analytics');setMenuOpen(false);}}>
              <span className="nav-icon">◎</span> Analytics
            </a>
            <a className={`nav-item ${activePage==='settings'?'active':''}`} href="#" onClick={(e)=>{e.preventDefault();setActivePage('settings');setMenuOpen(false);}}>
              <span className="nav-icon">⊕</span> Settings
            </a>
          </nav>
          <div className="sidebar-footer">
            <div className="ai-badge">
              <span className="ai-dot"/>
              <span>Morango Ai</span>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="topbar">
            <div>
              <h1 className="page-title">{activePage === 'dashboard' ? 'PR Coverage Dashboard' : activePage === 'articles' ? 'All Articles' : activePage === 'analytics' ? 'Analytics Overview' : 'Settings'}</h1>
              <p className="page-sub">{activePage === 'dashboard' ? 'Track, analyze and measure your media coverage with AI' : activePage === 'articles' ? 'View and manage all your tracked press release coverage' : activePage === 'analytics' ? 'Deep dive into sentiment and reach metrics' : 'Configure your tracking preferences and API connections'}</p>
            </div>
            {activePage !== 'settings' && (
              <button className="export-btn" onClick={exportCSV} disabled={filtered.length===0}>
                <span>↓</span> Export CSV
              </button>
            )}
          </div>

          {/* Metrics */}
          {(activePage === 'dashboard' || activePage === 'analytics') && (
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
          )}

          {/* Action Card */}
          {activePage === 'dashboard' && (
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

                <div className="track-types" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
                  {TRACK_TYPES.map(t => {
                    const isSelected = selectedTypes.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        className={`track-type-btn${isSelected?' active':''}`}
                        onClick={()=>{
                          if (isSelected) {
                            if (selectedTypes.length > 1) {
                              setSelectedTypes(selectedTypes.filter(id => id !== t.id));
                            }
                          } else {
                            setSelectedTypes([...selectedTypes, t.id]);
                          }
                        }}
                        disabled={tracking}
                        style={{
                          border: isSelected ? '1px solid rgba(99,102,241,0.5)' : '1px solid rgba(255,255,255,0.08)',
                          background: isSelected ? 'rgba(99,102,241,0.15)' : 'rgba(255,255,255,0.02)',
                        }}
                      >
                        <span className="track-icon" style={{ marginRight: '6px' }}>
                          {isSelected ? '✓' : t.icon}
                        </span>
                        {t.label}
                      </button>
                    );
                  })}
                </div>

                <div className="track-input-area" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  
                  {/* Title Input */}
                  {selectedTypes.includes('title') && (
                    <div className="ocr-field">
                      <label className="ocr-label">Article Title</label>
                      <div className="input-row">
                        <div className="input-wrap">
                          <span className="input-icon">◈</span>
                          <input
                            className="url-input"
                            type="text"
                            placeholder="Enter the exact article title or headline..."
                            value={titleQuery}
                            onChange={e=>setTitleQuery(e.target.value)}
                            onKeyDown={e=>e.key==='Enter'&&!tracking&&(
                              (selectedTypes.includes('title') && titleQuery.trim()) ||
                              (selectedTypes.includes('keywords') && keywordsQuery.trim()) ||
                              (selectedTypes.includes('hashtag') && hashtagQuery.trim()) ||
                              (selectedTypes.includes('document') && documentQuery.trim()) ||
                              (selectedTypes.includes('image') && ocrResult)
                            )&&trackCoverage()}
                            disabled={tracking}
                            style={{ paddingLeft: '38px' }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Keywords Input */}
                  {selectedTypes.includes('keywords') && (
                    <div className="ocr-field">
                      <label className="ocr-label">Keywords</label>
                      <div className="input-row">
                        <div className="input-wrap">
                          <span className="input-icon">⌖</span>
                          <input
                            className="url-input"
                            type="text"
                            placeholder="Enter keywords from the press release..."
                            value={keywordsQuery}
                            onChange={e=>setKeywordsQuery(e.target.value)}
                            onKeyDown={e=>e.key==='Enter'&&!tracking&&(
                              (selectedTypes.includes('title') && titleQuery.trim()) ||
                              (selectedTypes.includes('keywords') && keywordsQuery.trim()) ||
                              (selectedTypes.includes('hashtag') && hashtagQuery.trim()) ||
                              (selectedTypes.includes('document') && documentQuery.trim()) ||
                              (selectedTypes.includes('image') && ocrResult)
                            )&&trackCoverage()}
                            disabled={tracking}
                            style={{ paddingLeft: '38px' }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Hashtag Input */}
                  {selectedTypes.includes('hashtag') && (
                    <div className="ocr-field">
                      <label className="ocr-label">Hashtag</label>
                      <div className="input-row">
                        <div className="input-wrap">
                          <span className="input-icon">#</span>
                          <input
                            className="url-input"
                            type="text"
                            placeholder="#YourHashtag"
                            value={hashtagQuery}
                            onChange={e=>setHashtagQuery(e.target.value)}
                            onKeyDown={e=>e.key==='Enter'&&!tracking&&(
                              (selectedTypes.includes('title') && titleQuery.trim()) ||
                              (selectedTypes.includes('keywords') && keywordsQuery.trim()) ||
                              (selectedTypes.includes('hashtag') && hashtagQuery.trim()) ||
                              (selectedTypes.includes('document') && documentQuery.trim()) ||
                              (selectedTypes.includes('image') && ocrResult)
                            )&&trackCoverage()}
                            disabled={tracking}
                            style={{ paddingLeft: '38px' }}
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Press Release Document Input */}
                  {selectedTypes.includes('document') && (
                    <div className="ocr-field">
                      <label className="ocr-label">Press Release Text</label>
                      <textarea
                        className="track-textarea"
                        placeholder="Paste the full press release text here..."
                        value={documentQuery}
                        onChange={e=>setDocumentQuery(e.target.value)}
                        disabled={tracking}
                        rows={4}
                      />
                    </div>
                  )}

                  {/* Image Upload Input */}
                  {selectedTypes.includes('image') && (
                    <div className="ocr-field">
                      <label className="ocr-label">Upload Article Screenshot</label>
                      <div className="image-preview-container">
                        {!imagePreview ? (
                          <div 
                            className="upload-zone"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); if (e.dataTransfer.files?.[0]) handleImageUpload(e.dataTransfer.files[0]); }}
                            onClick={() => fileInputRef.current?.click()}
                          >
                            <input 
                              type="file" 
                              ref={fileInputRef} 
                              style={{ display: 'none' }} 
                              accept="image/*"
                              onChange={(e) => { if (e.target.files?.[0]) handleImageUpload(e.target.files[0]); }}
                            />
                            <div className="upload-icon">📷</div>
                            <p className="upload-title">Drag & drop your article image here or click to browse</p>
                            <p className="upload-sub">Supports PNG, JPG, JPEG up to 10MB</p>
                          </div>
                        ) : (
                          <div className="preview-container">
                            <div className="preview-image-wrap">
                              <img src={imagePreview} alt="Article upload" className="preview-image" />
                              {!ocrLoading && (
                                <button 
                                  className="remove-image-btn" 
                                  onClick={() => { 
                                    setImageFile(null); 
                                    setImagePreview(null); 
                                    setOcrResult(null); 
                                    setOcrError(''); 
                                  }}
                                >
                                  ✕ Remove Image
                                </button>
                              )}
                            </div>

                            {ocrLoading && (
                              <div className="ocr-loading-state">
                                <span className="spinner large" />
                                <p>Scanning image with AI Vision...</p>
                                <span className="ocr-step-msg">Extracting headline & search keywords...</span>
                              </div>
                            )}

                            {ocrError && (
                              <div className="msg err" style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                <div><strong>Scan Failed:</strong> {ocrError}</div>
                                <button className="retry-btn" onClick={() => handleImageUpload(imageFile)} style={{ alignSelf: 'flex-start' }}>
                                  ↻ Retry Scan
                                </button>
                              </div>
                            )}

                            {ocrResult && (
                              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '8px 4px' }}>
                                <h4 style={{ color: '#10b981', fontSize: '14px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  <span>✓</span> AI Vision Scan Complete
                                </h4>
                                <p style={{ color: '#64748b', fontSize: '12px', marginTop: '6px', lineHeight: '1.5' }}>
                                  Article headline and keywords successfully extracted in the background. They will be included in the coverage search.
                                </p>
                              </div>
                            )}
                          </div>
                        )}
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
                    disabled={tracking || !(
                      (selectedTypes.includes('title') && titleQuery.trim()) ||
                      (selectedTypes.includes('keywords') && keywordsQuery.trim()) ||
                      (selectedTypes.includes('hashtag') && hashtagQuery.trim()) ||
                      (selectedTypes.includes('document') && documentQuery.trim()) ||
                      (selectedTypes.includes('image') && ocrResult)
                    )}
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
          )}

          {/* Table */}
          {(activePage === 'dashboard' || activePage === 'articles') && (
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
          )}

          {/* Analytics View */}
          {activePage === 'analytics' && (
            <div className="analytics-panels" style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '24px', marginTop: '32px'}}>
              <div className="panel" style={{background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px'}}>
                <h3 style={{color: '#fff', marginBottom: '16px', fontSize: '18px', fontWeight: '600'}}>Sentiment Distribution</h3>
                <div style={{display: 'flex', gap: '8px', height: '30px', borderRadius: '8px', overflow: 'hidden', marginBottom: '16px'}}>
                  {articles.length > 0 ? (
                    <>
                      <div style={{width: `${posPct}%`, background: SENT.positive.text, transition: 'width 1s ease'}}/>
                      <div style={{width: `${(articles.filter(a=>a.sentiment==='neutral').length/articles.length*100)}%`, background: SENT.neutral.text, transition: 'width 1s ease'}}/>
                      <div style={{width: `${(articles.filter(a=>a.sentiment==='negative').length/articles.length*100)}%`, background: SENT.negative.text, transition: 'width 1s ease'}}/>
                    </>
                  ) : <div style={{width: '100%', background: 'rgba(255,255,255,0.05)'}}/>}
                </div>
                <div style={{display: 'flex', gap: '16px', color: '#94a3b8', fontSize: '14px'}}>
                  <span style={{display:'flex', alignItems:'center', gap:'6px'}}><span style={{width:'8px', height:'8px', borderRadius:'50%', background:SENT.positive.text}}></span> Positive ({posPct}%)</span>
                  <span style={{display:'flex', alignItems:'center', gap:'6px'}}><span style={{width:'8px', height:'8px', borderRadius:'50%', background:SENT.neutral.text}}></span> Neutral ({articles.length ? Math.round(articles.filter(a=>a.sentiment==='neutral').length/articles.length*100) : 0}%)</span>
                  <span style={{display:'flex', alignItems:'center', gap:'6px'}}><span style={{width:'8px', height:'8px', borderRadius:'50%', background:SENT.negative.text}}></span> Negative ({articles.length ? Math.round(articles.filter(a=>a.sentiment==='negative').length/articles.length*100) : 0}%)</span>
                </div>
              </div>

              <div className="panel" style={{background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '24px'}}>
                <h3 style={{color: '#fff', marginBottom: '16px', fontSize: '18px', fontWeight: '600'}}>Top Publications</h3>
                <div style={{display: 'flex', flexDirection: 'column', gap: '12px'}}>
                  {articles.length > 0 ? [...new Set(articles.map(a=>a.publication).filter(Boolean))].slice(0, 5).map(pub => {
                    const count = articles.filter(a=>a.publication===pub).length;
                    return (
                      <div key={pub} style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: '#cbd5e1', fontSize: '14px', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px'}}>
                        <span style={{fontWeight: '500'}}>{pub}</span>
                        <span style={{background: 'rgba(255,255,255,0.1)', color: '#fff', padding: '2px 8px', borderRadius: '12px', fontSize: '12px'}}>{count} article{count!==1?'s':''}</span>
                      </div>
                    )
                  }) : <div style={{color: '#64748b', fontSize: '14px'}}>No data available yet.</div>}
                </div>
              </div>
            </div>
          )}

          {/* Settings View */}
          {activePage === 'settings' && (
            <div className="settings-panel" style={{background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: '16px', padding: '32px', maxWidth: '700px', marginTop: '24px'}}>
              <h3 style={{color: '#fff', marginBottom: '8px', fontSize: '18px', fontWeight: '600'}}>System Configuration</h3>
              <p style={{color: '#94a3b8', fontSize: '14px', marginBottom: '32px', lineHeight: '1.6'}}>These settings are loaded securely from your server environment (<code>.env.local</code>). To change them, please update your environment variables and restart the server deployment.</p>
              
              <div style={{display: 'flex', flexDirection: 'column', gap: '24px'}}>
                <div>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', color: '#cbd5e1', fontSize: '14px', marginBottom: '8px', fontWeight: '500'}}>
                    <span style={{color: '#3b82f6'}}>⚡</span> n8n Analyze Webhook (POST)
                  </label>
                  <input type="text" readOnly value={N8N_ANALYZE || 'Not configured'} style={{width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', outline: 'none'}} />
                  <p style={{color: '#64748b', fontSize: '12px', marginTop: '6px'}}>Called automatically when the AI analyzes a new article URL.</p>
                </div>
                <div>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', color: '#cbd5e1', fontSize: '14px', marginBottom: '8px', fontWeight: '500'}}>
                    <span style={{color: '#10b981'}}>📥</span> n8n Get Articles Webhook (GET)
                  </label>
                  <input type="text" readOnly value={N8N_GET || 'Not configured'} style={{width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', outline: 'none'}} />
                  <p style={{color: '#64748b', fontSize: '12px', marginTop: '6px'}}>Called to populate the dashboard table on page load.</p>
                </div>
                <div>
                  <label style={{display: 'flex', alignItems: 'center', gap: '8px', color: '#cbd5e1', fontSize: '14px', marginBottom: '8px', fontWeight: '500'}}>
                    <span style={{color: '#ef4444'}}>🗑️</span> n8n Delete Webhook (POST)
                  </label>
                  <input type="text" readOnly value={N8N_DELETE || 'Not configured'} style={{width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)', color: '#94a3b8', padding: '12px 16px', borderRadius: '8px', fontSize: '14px', outline: 'none'}} />
                  <p style={{color: '#64748b', fontSize: '12px', marginTop: '6px'}}>Called when you delete an article from the dashboard.</p>
                </div>
              </div>
            </div>
          )}

        </main>
      </div>

      {modal && <TextModal title={modal.title} text={modal.text} onClose={()=>setModal(null)}/>}
    </>
  );
}
