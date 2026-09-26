// client/src/shared/ui/index.ts — the UI kit, milestone 14.
//
// Every component is taken from project/Main.dc.html, project/States.dc.html or
// project/AdminStates.dc.html. Nothing here is invented, and nothing here holds a hex value that is
// not a token — §2.2's rule, checked by `npm run check:styles`.

export { Button, RoundButton, Spinner } from './Button.tsx';
export type { ButtonVariant } from './Button.tsx';
export { CardBadge, Chip, OrderStatusBadge, PaymentStatusBadge } from './Badge.tsx';
export type { PaymentState, StatusTone } from './Badge.tsx';
export { DataTable } from './DataTable.tsx';
export type { Column } from './DataTable.tsx';
export { BagIcon, EmptyState } from './EmptyState.tsx';
export type { StateAction } from './EmptyState.tsx';
export { Alert, Skeleton, SkeletonCard, SkeletonRow, Toast } from './feedback.tsx';
export type { AlertTone } from './feedback.tsx';
export {
  Checkbox,
  PhoneField,
  QuantityStepper,
  Radio,
  Segmented,
  SelectField,
  Switch,
  TextField,
} from './fields.tsx';
export { OptionGroup } from './OptionGroup.tsx';
export type { OptionValue } from './OptionGroup.tsx';
export { BottomSheet, ConfirmModal, Drawer } from './overlays.tsx';
export { ProductCard } from './ProductCard.tsx';
export { SetupChecklist, StateCard } from './StateCard.tsx';
