/**
 * <EmptyPanel> 空数据引导与新建入口
 * 被全部列表页消费，保证任何列表为空时都有明确的下一步动作。
 */
import { Box, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import type { ReactNode } from 'react';

export interface EmptyPanelProps {
  title?: string;
  description?: ReactNode;
  createLabel?: string;
  onCreate?: () => void;
  resetLabel?: string;
  onReset?: () => void;
  extra?: ReactNode;
}

export default function EmptyPanel({
  title = '暂无数据',
  description = '当前筛选条件下没有记录，可新建一条或调整筛选条件。',
  createLabel,
  onCreate,
  resetLabel,
  onReset,
  extra,
}: EmptyPanelProps) {
  return (
    <Box
      sx={{
        p: 4,
        textAlign: 'center',
        border: '1px dashed rgba(25,118,210,0.35)',
        borderRadius: 2,
        backgroundColor: '#ffffff',
      }}
    >
      <InboxOutlinedIcon sx={{ fontSize: 40, color: 'rgba(0,0,0,0.24)' }} />
      <Typography variant="subtitle1" sx={{ mt: 1, fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {description}
      </Typography>
      <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
        {createLabel && onCreate ? (
          <Button variant="contained" startIcon={<AddIcon />} onClick={onCreate}>
            {createLabel}
          </Button>
        ) : null}
        {resetLabel && onReset ? (
          <Button variant="outlined" startIcon={<RefreshIcon />} onClick={onReset}>
            {resetLabel}
          </Button>
        ) : null}
        {extra}
      </Stack>
    </Box>
  );
}
