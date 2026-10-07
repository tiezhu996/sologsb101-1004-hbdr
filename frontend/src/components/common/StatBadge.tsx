/**
 * <StatBadge> 计数与占比徽标
 * 展示待修病害数、天窗占用率、销号率等指标，被站场台账页、天窗编排页消费。
 */
import { Box, Card, CardContent, LinearProgress, Tooltip, Typography } from '@mui/material';
import type { ReactNode } from 'react';

export interface StatBadgeProps {
  title: string;
  value: number | string;
  suffix?: string;
  /** 占比（0~100），提供时展示进度条 */
  percent?: number;
  color?: string;
  hint?: string;
  inline?: boolean;
  icon?: ReactNode;
}

export default function StatBadge({
  title,
  value,
  suffix,
  percent,
  color = '#1976d2',
  hint,
  inline = false,
  icon,
}: StatBadgeProps) {
  const body = (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        {icon}
        {title}
      </Typography>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
        <Typography variant={inline ? 'h6' : 'h5'} sx={{ fontWeight: 600, color }}>
          {value}
        </Typography>
        {suffix ? (
          <Typography variant="caption" color="text.secondary">
            {suffix}
          </Typography>
        ) : null}
      </Box>
      {typeof percent === 'number' ? (
        <LinearProgress
          variant="determinate"
          value={Math.max(0, Math.min(100, percent))}
          sx={{ height: 6, borderRadius: 3, mt: 0.5, backgroundColor: 'rgba(0,0,0,0.06)' }}
        />
      ) : null}
      {hint ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, lineHeight: 1.5 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );

  const wrapped = hint ? <Tooltip title={hint}>{body}</Tooltip> : body;

  if (inline) return wrapped;

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent sx={{ p: 1.75, '&:last-child': { pb: 1.75 } }}>{wrapped}</CardContent>
    </Card>
  );
}
