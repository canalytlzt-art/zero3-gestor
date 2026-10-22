import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export type PurpleSelectOption = {
  value: string;
  label: string;
};

type PurpleSelectProps = {
  value: string;
  options: PurpleSelectOption[];
  onValueChange: (value: string) => void;
  testId: string;
  className?: string;
};

export function PurpleSelect({ value, options, onValueChange, testId, className }: PurpleSelectProps) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger
        className={cn(
          'h-10 w-full justify-between border-[#e7e2ea] bg-[#fffefc] px-3 text-xs font-medium text-[#443d50] shadow-none focus:ring-2 focus:ring-[#9477bf]/20',
          className,
        )}
        data-testid={testId}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        side="bottom"
        align="start"
        sideOffset={4}
        className="z-[80] max-h-[var(--radix-select-content-available-height)] min-w-[var(--radix-select-trigger-width)] border-[#5c4088] bg-[#65479c] p-1 text-white shadow-[0_12px_32px_rgba(40,30,60,.28)]"
      >
        {options.map((option, index) => (
          <SelectItem
            key={option.value}
            value={option.value}
            title={option.label}
            data-testid={`${testId}-option-${index}`}
            className="min-w-0 rounded-lg py-2.5 text-xs text-white focus:bg-white/20 focus:text-white data-[highlighted]:bg-white/20 data-[highlighted]:text-white data-[state=checked]:bg-white/15 [&>span:last-child]:truncate"
          >
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
