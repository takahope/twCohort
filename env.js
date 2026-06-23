const ENV = {
  // 【機敏，請改設於 Script Properties】cHRM 正式資料表 ID，僅作為防呆比對。
  // 真實值須填入 GAS「專案設定 > 指令碼屬性」的 CHRM_MASTER_SHEET_ID；
  // 留空字串會讓防呆 guard 失效，故部署時務必於 Script Properties 設定。
  CHRM_MASTER_SHEET_ID: "",
  // 【機敏，請改設於 Script Properties】駐站護理師工時調派 App 的獨立資料來源。
  // 真實值須填入 GAS「專案設定 > 指令碼屬性」的 DISPATCH_SOURCE_SHEET_ID，不可填 cHRM 正式資料表 ID。
  DISPATCH_SOURCE_SHEET_ID: "",
  // 獨立資料來源中的人員主檔分頁。用於讀取狀態並排除育嬰、留停等不可調配人力。
  DISPATCH_PERSONNEL_SHEET_GID: 198337618,
  // 獨立資料來源中的人員職務配置分頁。優先用 gid，避免同名分頁或順序變動讀錯。
  DISPATCH_ASSIGNMENT_SHEET_GID: 184185852,
  // 測試模式只開放白名單或資料表職稱符合下列設定者。
  TESTER_EMAILS: ["eric1207cvb@as.edu.tw", "itsutaka@as.edu.tw"],
  TESTER_TITLES: ["系統測試人員", "測試人員"],
  // 開啟後，後端不修改正式主檔人員、組織與職務配置；臨時調配欄同步由下方設定獨立控制。
  MASTER_DATA_READ_ONLY: true,
  // 只允許將 Web App 的臨時調派摘要同步寫入「人員職務配置」的「臨時調配」欄。
  SYNC_TEMPORARY_DISPATCH_COLUMN: true,
  // 只有人員職務配置中的 orgCode 命中以下白名單者，才可看到彩蛋按鈕
  EASTER_EGG_ALLOWED_ORG_CODES: []
};
