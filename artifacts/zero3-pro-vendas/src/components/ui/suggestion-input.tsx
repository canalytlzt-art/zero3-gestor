import { forwardRef, useMemo, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type SuggestionInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  suggestions: string[];
  suggestionTitle: string;
  testId: string;
};

function searchKey(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}

export const SuggestionInput = forwardRef<HTMLInputElement, SuggestionInputProps>(function SuggestionInput(
  {
    value,
    onValueChange,
    suggestions,
    suggestionTitle,
    testId,
    className,
    onFocus,
    onBlur,
    onKeyDown,
    ...inputProps
  },
  ref,
) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listId = `${testId}-suggestions`;
  const normalizedValue = searchKey(value);
  const matches = useMemo(
    () => suggestions.filter((name) => !normalizedValue || searchKey(name).includes(normalizedValue)).slice(0, 10),
    [normalizedValue, suggestions],
  );
  const showList = open && matches.length > 0;

  const choose = (name: string) => {
    onValueChange(name);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || matches.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) => (current <= 0 ? matches.length - 1 : current - 1));
    } else if (event.key === 'Enter' && showList && activeIndex >= 0) {
      event.preventDefault();
      choose(matches[activeIndex]);
    } else if (event.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="relative w-full" data-testid={`${testId}-control`}>
      <input
        {...inputProps}
        ref={ref}
        value={value}
        onChange={(event) => { setActiveIndex(-1); setOpen(true); onValueChange(event.target.value); }}
        onFocus={(event) => { setOpen(true); onFocus?.(event); }}
        onClick={() => setOpen(true)}
        onBlur={(event) => {
          onBlur?.(event);
          window.setTimeout(() => { setOpen(false); setActiveIndex(-1); }, 100);
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        data-testid={testId}
        className={cn(
          'h-11 w-full rounded-xl border border-[#e7e2ea] bg-[#fcfbfd] px-3.5 text-sm text-[#342d43] outline-none transition placeholder:text-[#aaa4b0] focus:border-[#9477bf] focus:bg-white focus:ring-2 focus:ring-[#7656b8]/10',
          className,
        )}
      />
      {showList && (
        <div
          className="absolute inset-x-0 top-full z-[80] mt-1.5 overflow-hidden rounded-xl border border-[#5c4088] bg-[#65479c] text-white shadow-[0_12px_32px_rgba(40,30,60,.28)]"
          data-testid={`${testId}-suggestion-list`}
        >
          <p className="border-b border-white/15 px-3 py-2 text-[9px] font-bold uppercase tracking-[.12em] text-white/70">
            {suggestionTitle}
          </p>
          <ul id={listId} role="listbox" aria-label={suggestionTitle} className="max-h-48 overflow-y-auto p-1">
            {matches.map((name, index) => {
              const selected = searchKey(name) === normalizedValue;
              const active = activeIndex === index;
              return (
                <li
                  key={`${name}-${index}`}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={selected}
                  onPointerDown={(event) => { if (event.pointerType === 'mouse') event.preventDefault(); }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(name)}
                  className={cn(
                    'flex min-h-9 cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs font-semibold text-white transition',
                    active ? 'bg-white/20' : 'hover:bg-white/15',
                  )}
                  data-testid={`${testId}-suggestion-${index}`}
                >
                  <span className="min-w-0 truncate">{name}</span>
                  {selected && <Check size={14} className="shrink-0 text-white/90" aria-hidden="true" />}
                </li>
              );
            })}
          </ul>
          <p className="border-t border-white/15 px-3 py-2 text-[10px] text-white/75">
            Você também pode digitar um novo nome.
          </p>
        </div>
      )}
    </div>
  );
});
