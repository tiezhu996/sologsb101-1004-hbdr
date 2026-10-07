/** 测试辅助：把正式台账与接收区替换成确定性数据，保证对回结果可预期 */
import { db } from '../src/utils/db';
import type { LedgerSnapshot } from '../src/types/intake';

export async function resetToLedger(ledger: LedgerSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.yards, db.switches, db.inspections, db.faults, db.workOrders, db.restrictions, db.intakeBatches, db.settings],
    async () => {
      await Promise.all([
        db.yards.clear(),
        db.switches.clear(),
        db.inspections.clear(),
        db.faults.clear(),
        db.workOrders.clear(),
        db.restrictions.clear(),
        db.intakeBatches.clear(),
        db.settings.clear(),
      ]);
      await db.yards.bulkPut(ledger.yards);
      await db.switches.bulkPut(ledger.switches);
      await db.inspections.bulkPut(ledger.inspections);
      await db.faults.bulkPut(ledger.faults);
      await db.workOrders.bulkPut(ledger.workOrders);
    },
  );
}
