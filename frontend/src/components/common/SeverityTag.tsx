/**
 * <SeverityTag> 病害等级标签
 * 按轻 / 中 / 重渲染底色与图标，被巡检录入页、病害评定页消费。
 */
import { Chip, Tooltip } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import type { FaultSeverity } from '../../types/fault';
import { FAULT_SEVERITY_LABEL } from '../../types/fault';
import { SEVERITY_BG, SEVERITY_HEX, severityText, sizeSeverityHint } from '../../utils/severity';

export interface SeverityTagProps {
  severity: FaultSeverity;
  /** 尺寸（mm），展示时附在提示中 */
  sizeMm?: number | null;
  size?: 'small' | 'medium';
  /** 是否展示图标 */
  showIcon?: boolean;
}

export default function SeverityTag({ severity, sizeMm, size = 'small', showIcon = true }: SeverityTagProps) {
  const icon =
    severity === 'heavy' ? (
      <ErrorOutlineIcon />
    ) : severity === 'medium' ? (
      <WarningAmberIcon />
    ) : (
      <CheckCircleOutlineIcon />
    );
  const tooltip = [
    `等级：${FAULT_SEVERITY_LABEL[severity]}`,
    typeof sizeMm === 'number' ? `尺寸：${sizeMm} mm` : '尺寸：未记录',
    sizeSeverityHint(typeof sizeMm === 'number' ? sizeMm : null),
  ].join(' · ');

  return (
    <Tooltip title={tooltip}>
      <Chip
        size={size}
        icon={showIcon ? icon : undefined}
        label={severityText(severity)}
        sx={{
          backgroundColor: SEVERITY_BG[severity],
          color: SEVERITY_HEX[severity],
          border: `1px solid ${SEVERITY_HEX[severity]}`,
          fontWeight: severity === 'heavy' ? 600 : 400,
        }}
      />
    </Tooltip>
  );
}
