/** 持久化行元信息：所有落库实体共用的行修订号 */
export const ROW_REVISION = 2;

/** 行修订号，用于按行迁移与版本核对 */
export interface Revisioned {
  revision: number;
}
