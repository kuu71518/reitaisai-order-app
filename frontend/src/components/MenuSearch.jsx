import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getMenuSearchSuggestions } from '../lib/menuSearch';
import '../styles/menu-search.css';

export default function MenuSearch({ query, category, groups, onQueryChange, onChoose }) {
  const listId = useId();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [isOpen, setIsOpen] = useState(false);
  const [activeKey, setActiveKey] = useState(null);
  const suggestions = useMemo(
    () => getMenuSearchSuggestions(groups, query, { category }),
    [groups, query, category],
  );
  const activeIndex = suggestions.findIndex((suggestion) => suggestion.key === activeKey);
  const showSuggestions = isOpen && query.trim().length > 0;
  const expanded = showSuggestions && suggestions.length > 0;

  useEffect(() => {
    if (expanded && activeIndex >= 0) {
      listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, expanded]);

  const choose = (suggestion) => {
    onChoose(suggestion);
    setIsOpen(false);
    setActiveKey(null);
    inputRef.current?.focus();
  };

  const handleKeyDown = (event) => {
    // Enter used to confirm Japanese text must never select a suggestion.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      if (isOpen) event.preventDefault();
      setIsOpen(false);
      setActiveKey(null);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (suggestions.length === 0) return;
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const index = !expanded || activeIndex < 0
        ? (offset === 1 ? 0 : suggestions.length - 1)
        : (activeIndex + offset + suggestions.length) % suggestions.length;
      setIsOpen(true);
      setActiveKey(suggestions[index].key);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (expanded && activeIndex >= 0) choose(suggestions[activeIndex]);
      else setIsOpen(false);
    }
  };

  return (
    <div className="menu-search">
      <label className="sr-only" htmlFor={`${listId}-input`}>商品名・項目でメニューを検索</label>
      <div className="menu-search-input">
        <span aria-hidden="true">⌕</span>
        <input
          ref={inputRef}
          id={`${listId}-input`}
          type="search"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-describedby={`${listId}-help`}
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setActiveKey(null);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => { setIsOpen(false); setActiveKey(null); }}
          onKeyDown={handleKeyDown}
          placeholder="商品名・項目（例：ビール）"
          autoComplete="off"
          enterKeyHint="search"
          spellCheck={false}
        />
        {query && (
          <button type="button" onClick={() => {
            onQueryChange('');
            setActiveKey(null);
            setIsOpen(false);
            inputRef.current?.focus();
          }} aria-label="検索語を消す">消す</button>
        )}
      </div>
      <span id={`${listId}-help`} className="sr-only">商品名・項目・サイズで検索できます。候補は上下キーで選び、Enterで確定、Escapeで閉じます。</span>
      {showSuggestions && (
        <div className="menu-search-popup">
          {suggestions.length > 0 ? (
            <ul id={listId} ref={listRef} role="listbox" aria-label="検索候補">
              {suggestions.map((suggestion, index) => (
                <li
                  key={suggestion.key}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={activeIndex === index}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => choose(suggestion)}
                >
                  <span className="menu-search-kind">{suggestion.kind === 'category' ? '項目' : '商品'}</span>
                  <span className="menu-search-label">{suggestion.label}</span>
                  {suggestion.kind === 'product' && <small>{suggestion.category}</small>}
                </li>
              ))}
            </ul>
          ) : <p role="status">検索候補がありません。短い言葉でお試しください。</p>}
        </div>
      )}
    </div>
  );
}
