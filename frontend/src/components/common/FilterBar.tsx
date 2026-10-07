/**
 * <FilterBar> 关键字 + 多选条件筛选条
 * 条件与 URL query 同步（刷新/分享链接后筛选状态不丢），
 * 被巡检录入页、病害评定页、进度页消费。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  OutlinedInput,
  Select,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';

export interface FilterBarOption {
  label: string;
  value: string;
}

export interface FilterBarSelect {
  /** query 参数名 */
  key: string;
  label: string;
  options: FilterBarOption[];
  /** 是否多选，默认 true */
  multiple?: boolean;
  width?: number;
  placeholder?: string;
}

export interface FilterBarProps {
  keywordPlaceholder?: string;
  keywordKey?: string;
  selects?: FilterBarSelect[];
  extra?: React.ReactNode;
  resultCount?: number;
  countUnit?: string;
  /** 筛选变化回调（URL 已同步） */
  onChange?: (values: { keyword: string; filters: Record<string, string[]> }) => void;
}

function readValues(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function FilterBar({
  keywordPlaceholder = '按名称 / 编号搜索',
  keywordKey = 'kw',
  selects = [],
  extra,
  resultCount,
  countUnit = '条',
  onChange,
}: FilterBarProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [keyword, setKeyword] = useState(() => searchParams.get(keywordKey) ?? '');

  const selectKeys = useMemo(() => selects.map((item) => item.key).join(','), [selects]);

  const filters = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const key of selectKeys.split(',').filter(Boolean)) {
      result[key] = readValues(searchParams, key);
    }
    return result;
  }, [searchParams, selectKeys]);

  useEffect(() => {
    const current = searchParams.get(keywordKey) ?? '';
    setKeyword((prev) => (prev === current ? prev : current));
  }, [searchParams, keywordKey]);

  const push = useCallback(
    (nextKeyword: string, nextFilters: Record<string, string[]>) => {
      const params = new URLSearchParams(searchParams);
      if (nextKeyword.trim()) params.set(keywordKey, nextKeyword.trim());
      else params.delete(keywordKey);
      for (const select of selects) {
        const values = nextFilters[select.key] ?? [];
        if (values.length > 0) params.set(select.key, values.join(','));
        else params.delete(select.key);
      }
      setSearchParams(params, { replace: true });
      onChange?.({ keyword: nextKeyword.trim(), filters: nextFilters });
    },
    [searchParams, setSearchParams, keywordKey, selects, onChange],
  );

  const activeCount =
    (keyword.trim() ? 1 : 0) + Object.values(filters).filter((values) => values.length > 0).length;

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ p: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1.25} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField
            size="small"
            value={keyword}
            placeholder={keywordPlaceholder}
            onChange={(event) => {
              setKeyword(event.target.value);
              push(event.target.value, filters);
            }}
            InputProps={{
              startAdornment: <SearchIcon fontSize="small" sx={{ mr: 0.5, color: 'text.secondary' }} />,
            }}
            sx={{ minWidth: 240 }}
          />
          {selects.map((select) => (
            <FormControl key={select.key} size="small" sx={{ minWidth: select.width ?? 170 }}>
              <InputLabel>{select.label}</InputLabel>
              <Select
                multiple={select.multiple !== false}
                value={select.multiple === false ? (filters[select.key]?.[0] ?? '') : (filters[select.key] ?? [])}
                onChange={(event) => {
                  const value = event.target.value;
                  const next = { ...filters };
                  next[select.key] = Array.isArray(value) ? value : value ? [String(value)] : [];
                  push(keyword, next);
                }}
                input={<OutlinedInput label={select.label} />}
                renderValue={(selected) =>
                  Array.isArray(selected)
                    ? selected
                        .map((value) => select.options.find((item) => item.value === value)?.label ?? value)
                        .join('、')
                    : (select.options.find((item) => item.value === selected)?.label ?? String(selected))
                }
              >
                {select.options.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          ))}
          <Button
            size="small"
            startIcon={<ClearIcon />}
            disabled={activeCount === 0}
            onClick={() => {
              setKeyword('');
              const cleared: Record<string, string[]> = {};
              for (const select of selects) cleared[select.key] = [];
              push('', cleared);
            }}
          >
            重置
          </Button>
          {typeof resultCount === 'number' ? (
            <Chip size="small" color="info" label={`${resultCount} ${countUnit}`} />
          ) : null}
          {extra}
          {activeCount > 0 ? (
            <Typography variant="caption" color="text.secondary">
              已启用 {activeCount} 个筛选条件
            </Typography>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}

/** 从 URL query 读取筛选值（页面派生过滤用） */
export function useFilterValues(keys: string[]): Record<string, string[]> {
  const [searchParams] = useSearchParams();
  const joined = keys.join(',');
  return useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const key of joined.split(',').filter(Boolean)) {
      result[key] = readValues(searchParams, key);
    }
    return result;
  }, [searchParams, joined]);
}

/** 关键字筛选值 */
export function useKeywordFilter(key = 'kw'): string {
  const [searchParams] = useSearchParams();
  return searchParams.get(key) ?? '';
}
