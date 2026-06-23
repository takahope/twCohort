const APP_CONFIG = {
  title: '駐站護理師工時調派',
  personnelSheetName: '人員主檔',
  orgSheetName: '組織架構樹',
  assignmentSheetName: '人員職務配置',
  stationCodePrefix: 'GRP-CO-',
  externalStationCodePrefix: 'GRP-CO-EX-',
  stationManagerTitle: '駐站管理員',
  storeKey: 'stationNurseWorkHours:v1',
  testStoreKey: 'stationNurseWorkHours:test:v1',
  auditLogStoreKey: 'stationNurseWorkHours:audit:v1',
  testAuditLogStoreKey: 'stationNurseWorkHours:audit:test:v1',
  recordSheetPrefix: '調派紀錄_',
  auditLogSheetPrefix: '調派操作紀錄_',
  testRecordSheetPrefix: '測試調派紀錄_',
  testAuditLogSheetPrefix: '測試調派操作紀錄_',
  testStationsStoreKey: 'stationNurseStations:test:v1',
  testHiddenStationCodesStoreKey: 'stationNurseStations:hidden:test:v1',
  sourceCacheKey: 'stationNurseDispatchSource:v1',
  recordsCacheKey: 'stationNurseWorkHours:records:v1',
  testRecordsCacheKey: 'stationNurseWorkHours:records:test:v1',
  holidayCacheKey: 'stationNurseOfficialHolidays:v1',
  holidayRefreshStoreKey: 'stationNurseOfficialHolidays:refresh:v1',
  holidayRefreshTriggerFunction: 'refreshOfficialHolidayCalendarCache',
  holidayDatasetCsvUrl: 'https://data.ntpc.gov.tw/api/datasets/308dcd75-6434-45bc-a95f-584da4fed251/csv/file',
  holidayDatasetPageUrl: 'https://data.gov.tw/dataset/123662',
  cacheMaxChars: 90000,
  sourceCacheSeconds: 120,
  recordsCacheSeconds: 45,
  holidayCacheSeconds: 43200,
  holidayRefreshHour: 5,
  holidayRefreshLookAheadYears: 2,
  writeLockWaitMs: 30000,
  chunkSize: 8000,
  maxRecords: 3000,
  maxAuditLogs: 1000,
  maxDispatchRecordsPerYear: 10000,
  maxDispatchAuditLogsPerYear: 30000,
  defaultRangeDays: 31,
  temporaryDispatchCooldownDays: 30,
  maxHoursPerRecord: 24,
  pendingAssignmentStatus: '待指派',
  pendingDispatchNurseName: '待指派',
  fullShiftBreakHours: 1,
  fullShiftBreakThresholdHours: 8,
  unavailableStatusKeywords: ['育嬰', '留停', '留職停薪', '停薪', '留職', '停職', '休職'],
  shiftOptions: ['正常班', '行動收案']
};

let officialHolidayDatasetRowsCache_ = null;

const DISPATCH_ANNUAL_STORE_HEADERS_ = ['年度', '資料ID', '資料JSON', '更新時間'];

const FIELD_ALIASES = {
  email: ['信箱', '電子信箱', '電子郵件', 'Email', 'email', '使用者信箱', '帳號'],
  name: ['姓名', '人員姓名', '名稱', 'name'],
  status: ['狀態', '人員狀態', 'status'],
  orgCode: ['所屬組別代碼', '組別代碼', '組織代碼', '單位代碼', 'orgCode', 'OrgCode'],
  orgName: ['所屬組別', '所屬組別名稱', '組別名稱', '組織名稱', '單位名稱', 'orgName'],
  title: ['職稱', '職務', '角色', 'title'],
  managerEmail: ['主管信箱', '管理員信箱', '駐站管理員信箱', 'managerEmail'],
  managerName: ['主管姓名', '管理員姓名', '駐站管理員姓名', 'managerName'],
  temporaryDispatch: ['臨時調配', '臨調', 'temporaryDispatch'],
  orgType: ['類型', '組織類型', 'type'],
  level: ['層級', 'level'],
  alias: ['簡稱', '別名', 'alias'],
  parentCode: ['上層代碼', '母層代碼', 'parentCode'],
  iso: ['驗證範圍', 'ISO', 'iso']
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle(APP_CONFIG.title)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getCurrentUserEmail() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (error) {
    return '';
  }
}

function authorizeOfficialHolidayCalendar() {
  const currentYear = Number(getTodayDateString_().slice(0, 4));
  const refreshResult = refreshOfficialHolidayCalendarCache({ years: [currentYear] });
  if (!refreshResult || refreshResult.success === false) {
    throw new Error(refreshResult && refreshResult.message ? refreshResult.message : '官方假日資料授權失敗。');
  }
  const source = buildOfficialHolidaySourceInfo_({
    available: true,
    years: [currentYear],
    count: refreshResult.yearResults && refreshResult.yearResults[0]
      ? refreshResult.yearResults[0].count
      : 0
  });
  return `官方假日資料授權成功：${source.provider}「${source.name}」已可讀取，${currentYear} 年目前 ${source.count} 筆提示日期。`;
}

function installOfficialHolidayRefreshTrigger() {
  const functionName = APP_CONFIG.holidayRefreshTriggerFunction;
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === functionName)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(functionName)
    .timeBased()
    .everyDays(1)
    .atHour(APP_CONFIG.holidayRefreshHour)
    .create();

  const refreshResult = refreshOfficialHolidayCalendarCache();
  const message = refreshResult && refreshResult.message
    ? refreshResult.message
    : '官方假日資料已刷新。';
  return `官方假日資料每日更新已建立：每天 ${APP_CONFIG.holidayRefreshHour}:00 左右檢查官方 CSV。${message}`;
}

function ensureOfficialHolidayRefreshTrigger_() {
  try {
    const properties = PropertiesService.getScriptProperties();
    const today = getTodayDateString_();
    const checkKey = `${APP_CONFIG.holidayRefreshStoreKey}:triggerCheckDate`;
    if (properties.getProperty(checkKey) === today) return;

    const functionName = APP_CONFIG.holidayRefreshTriggerFunction;
    const hasTrigger = ScriptApp.getProjectTriggers()
      .some((trigger) => trigger.getHandlerFunction() === functionName);
    if (!hasTrigger) {
      ScriptApp.newTrigger(functionName)
        .timeBased()
        .everyDays(1)
        .atHour(APP_CONFIG.holidayRefreshHour)
        .create();
      properties.setProperty(`${APP_CONFIG.holidayRefreshStoreKey}:triggerInstalledAt`, formatTimestamp_(new Date()));
    }
    properties.setProperty(checkKey, today);
  } catch (error) {
    console.error('確認官方假日每日更新 trigger 失敗:', error);
  }
}

function removeOfficialHolidayRefreshTrigger() {
  const functionName = APP_CONFIG.holidayRefreshTriggerFunction;
  let removedCount = 0;
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === functionName)
    .forEach((trigger) => {
      ScriptApp.deleteTrigger(trigger);
      removedCount += 1;
    });
  return `官方假日資料每日更新已移除 ${removedCount} 個 trigger。`;
}

function refreshOfficialHolidayCalendarCache(payload) {
  const refreshedAt = formatTimestamp_(new Date());
  const years = getOfficialHolidayRefreshYears_(payload);

  try {
    clearOfficialHolidayCache_(years);
    const rows = getOfficialHolidayDatasetRows_({ forceFresh: true });
    const yearResults = years.map((year) => {
      const entries = parseOfficialHolidayEntriesForYear_(rows, year);
      putCachedJson_(`${APP_CONFIG.holidayCacheKey}:${year}`, entries, APP_CONFIG.holidayCacheSeconds);
      return {
        year,
        count: entries.length,
        available: entries.length > 0
      };
    });
    const metadata = {
      refreshedAt,
      years,
      yearResults,
      missingYears: yearResults.filter((item) => !item.available).map((item) => item.year),
      csvUrl: getEnvString_('DISPATCH_HOLIDAY_DATA_URL', APP_CONFIG.holidayDatasetCsvUrl),
      schedule: `每日 ${APP_CONFIG.holidayRefreshHour}:00 左右自動檢查官方 CSV`
    };
    setOfficialHolidayRefreshMetadata_(metadata);

    return {
      success: true,
      ...metadata,
      message: buildOfficialHolidayRefreshMessage_(metadata)
    };
  } catch (error) {
    const metadata = {
      refreshedAt,
      years,
      yearResults: [],
      missingYears: years,
      csvUrl: getEnvString_('DISPATCH_HOLIDAY_DATA_URL', APP_CONFIG.holidayDatasetCsvUrl),
      schedule: `每日 ${APP_CONFIG.holidayRefreshHour}:00 左右自動檢查官方 CSV`,
      error: error && error.message ? error.message : '官方假日資料刷新失敗。'
    };
    setOfficialHolidayRefreshMetadata_(metadata);
    console.error('刷新官方假日資料失敗:', error);
    return {
      success: false,
      ...metadata,
      message: metadata.error
    };
  }
}

function getDispatchAppData(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }
    ensureOfficialHolidayRefreshTrigger_();

    const filters = normalizeDispatchFilters_(payload);
    const source = loadDispatchSource_();
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const allowedStationCodes = new Set(context.stations.map((station) => station.code));
    const assignmentAvailabilityByKey = buildAssignmentAvailabilityByKey_(source.assignments);
    const records = loadDispatchRecords_(allowedStationCodes, filters, {
      testMode: context.viewer.testMode,
      assignmentAvailabilityByKey
    });
    const scheduleRecords = loadDispatchRecords_(allowedStationCodes, {
      ...filters,
      stationCode: '',
      nurseEmail: ''
    }, {
      testMode: context.viewer.testMode,
      includeOriginalStation: true,
      assignmentAvailabilityByKey
    });
    const today = getTodayDateString_();
    const currentRecords = loadDispatchRecords_(allowedStationCodes, {
      dateFrom: today,
      dateTo: today,
      stationCode: '',
      nurseEmail: ''
    }, {
      testMode: context.viewer.testMode,
      includeOriginalStation: true,
      assignmentAvailabilityByKey
    });
    const holidayCalendar = loadOfficialHolidayCalendarForRange_(filters.dateFrom, filters.dateTo);

    return {
      success: true,
      viewer: context.viewer,
      stations: context.stations,
      nurses: context.nurses,
      records,
      scheduleRecords,
      currentRecords,
      holidays: holidayCalendar.holidays,
      holidaySource: holidayCalendar.source,
      filters,
      shiftOptions: APP_CONFIG.shiftOptions.slice(),
      managerCandidates: buildStationManagerCandidates_(source)
    };
  } catch (error) {
    console.error('讀取工時調派資料失敗:', error);
    return {
      success: false,
      viewer: {
        email: viewerEmail,
        name: '',
        isStationManager: false
      },
      stations: [],
      nurses: [],
      records: [],
      scheduleRecords: [],
      currentRecords: [],
      holidays: {},
      holidaySource: buildOfficialHolidaySourceInfo_({ available: false }),
      filters: normalizeDispatchFilters_(payload),
      shiftOptions: APP_CONFIG.shiftOptions.slice(),
      managerCandidates: [],
      message: error && error.message ? error.message : '無法讀取工時調派資料。'
    };
  }
}

function getDispatchFairnessStats(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    const year = normalizeYear_(payload && payload.year);
    const filters = {
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      stationCode: normalizeOrgCode_(payload && payload.stationCode),
      nurseEmail: normalizeEmail_(payload && payload.nurseEmail)
    };
    const source = loadDispatchSource_();
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const allowedStationCodes = new Set(context.stations.map((station) => station.code));
    const assignmentAvailabilityByKey = buildAssignmentAvailabilityByKey_(source.assignments);
    const records = loadDispatchRecords_(allowedStationCodes, {
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      stationCode: '',
      nurseEmail: filters.nurseEmail
    }, {
      testMode: context.viewer.testMode,
      includeOriginalStation: true,
      assignmentAvailabilityByKey
    })
      .filter((record) => isTemporaryDispatchRecord_(record))
      .filter((record) => !isPendingAssignmentRecord_(record))
      .filter((record) => !filters.stationCode || record.stationCode === filters.stationCode || record.originalStationCode === filters.stationCode);

    return {
      success: true,
      year,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      filters,
      cooldownDays: APP_CONFIG.temporaryDispatchCooldownDays,
      stationStats: buildFairnessStationStats_(records, context.stations),
      nurseStats: buildFairnessNurseStats_(records),
      records,
      auditLogs: getDispatchAuditLogs_(allowedStationCodes, filters, context)
    };
  } catch (error) {
    console.error('讀取年度臨時徵調統計失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法讀取年度臨時徵調統計。'
    };
  }
}

function saveWorkHourDispatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const normalized = normalizeWorkHourPayload_(payload, context, viewerEmail);
    const records = getStoredDispatchRecords_(context);
    const existingIndex = normalized.id
      ? records.findIndex((record) => record.id === normalized.id && record.status === '有效')
      : -1;
    if (normalized.id && existingIndex < 0) {
      const inactiveRecord = records.find((record) => record.id === normalized.id);
      if (inactiveRecord) {
        throw new Error(buildDispatchDeletedConflictMessage_(inactiveRecord, '儲存', source));
      }
      throw new Error('找不到要編輯的調派紀錄。請先按「重新整理」查看最新調派內容。');
    }
    assertNoOverlappingNurseDispatch_(normalized, records);
    assertTemporaryDispatchCooldown_(normalized, records);
    const previousAssignmentKey = existingIndex >= 0 ? records[existingIndex].assignmentKey : '';
    const now = formatTimestamp_(new Date());
    let savedRecord = null;
    let auditAction = 'create';
    let previousRecord = null;

    if (existingIndex >= 0) {
      const existing = records[existingIndex];
      assertCanManageStation_(context, existing.stationCode);
      assertDispatchRecordVersion_(existing, payload, '儲存', source);
      previousRecord = existing;
      savedRecord = {
        ...existing,
        ...normalized,
        id: existing.id,
        createdAt: existing.createdAt,
        createdBy: existing.createdBy,
        version: createDispatchRecordVersion_(),
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      };
      auditAction = 'update';
      records.splice(existingIndex, 1, savedRecord);
    } else {
      savedRecord = {
        ...normalized,
        id: Utilities.getUuid(),
        version: createDispatchRecordVersion_(),
        createdAt: now,
        createdBy: viewerEmail,
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      };
      records.unshift(savedRecord);
    }

    saveStoredDispatchRecords_(records, context);
    appendDispatchAuditLogs_([
      buildDispatchAuditLog_(auditAction, savedRecord, {
        context,
        source,
        viewerEmail,
        occurredAt: now,
        previousRecord
      })
    ], context);
    syncTemporaryDispatchColumn_(source, records, [
      normalized.assignmentKey,
      previousAssignmentKey
    ], context);
    lock.releaseLock();
    hasLock = false;
    return getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
  } catch (error) {
    console.error('儲存工時調派失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法儲存工時調派。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function saveWorkHourDispatchBatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    if (payload && payload.id) {
      throw new Error('整個駐站調派只能用於新增，不可用於修改既有紀錄。');
    }

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const assignmentKeys = normalizeAssignmentKeys_(payload && payload.assignmentKeys);
    if (!assignmentKeys.length) {
      throw new Error('請選擇要批次調派的來源駐站人員。');
    }

    const normalizedRecords = assignmentKeys.map((assignmentKey) => normalizeWorkHourPayload_({
      ...payload,
      id: '',
      assignmentKey
    }, context, viewerEmail));
    const records = getStoredDispatchRecords_(context);
    const now = formatTimestamp_(new Date());
    const pendingRecords = [];

    normalizedRecords.forEach((normalized) => {
      assertNoOverlappingNurseDispatch_(normalized, records.concat(pendingRecords));
      assertTemporaryDispatchCooldown_(normalized, records.concat(pendingRecords));
      pendingRecords.push({
        ...normalized,
        id: Utilities.getUuid(),
        version: createDispatchRecordVersion_(),
        createdAt: now,
        createdBy: viewerEmail,
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      });
    });

    records.unshift(...pendingRecords);
    saveStoredDispatchRecords_(records, context);
    appendDispatchAuditLogs_(pendingRecords.map((record) => buildDispatchAuditLog_('create', record, {
      context,
      source,
      viewerEmail,
      occurredAt: now
    })), context);
    syncTemporaryDispatchColumn_(source, records, normalizedRecords.map((record) => record.assignmentKey), context);
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
    response.createdCount = pendingRecords.length;
    return response;
  } catch (error) {
    console.error('批次儲存工時調派失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法批次儲存工時調派。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function savePendingWorkHourDispatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    if (payload && payload.id) {
      throw new Error('待指派需求只能新增，不可用此動作修改既有紀錄。');
    }

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const normalized = normalizePendingWorkHourPayload_(payload, source, context, viewerEmail);
    const records = getStoredDispatchRecords_(context);
    assertNoDuplicatePendingDispatchDemand_(normalized, records);
    const now = formatTimestamp_(new Date());

    const pendingRecord = {
      ...normalized,
      id: Utilities.getUuid(),
      version: createDispatchRecordVersion_(),
      createdAt: now,
      createdBy: viewerEmail,
      updatedAt: now,
      updatedBy: viewerEmail,
      status: '有效'
    };
    records.unshift(pendingRecord);

    saveStoredDispatchRecords_(records, context);
    appendDispatchAuditLogs_([
      buildDispatchAuditLog_('create-pending', pendingRecord, {
        context,
        source,
        viewerEmail,
        occurredAt: now
      })
    ], context);
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
    response.createdCount = 1;
    return response;
  } catch (error) {
    console.error('建立待指派調派需求失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法建立待指派調派需求。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function assignPendingWorkHourDispatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    const id = String(payload && payload.id || '').trim();
    if (!id) {
      throw new Error('缺少待指派需求 ID。');
    }

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const records = getStoredDispatchRecords_(context);
    const targetIndex = records.findIndex((record) => record.id === id && record.status === '有效');
    if (targetIndex < 0) {
      const inactiveRecord = records.find((record) => record.id === id);
      if (inactiveRecord) {
        throw new Error(buildDispatchDeletedConflictMessage_(inactiveRecord, '指派', source));
      }
      throw new Error('找不到要指派的待指派需求。請先按「重新整理」查看最新月曆。');
    }

    const pendingRecord = records[targetIndex];
    if (!isPendingAssignmentRecord_(pendingRecord)) {
      throw new Error('這筆需求已經有確定人選，請重新整理月曆。');
    }
    assertCanManageRelatedStation_(context, pendingRecord.stationCode, pendingRecord.originalStationCode, '指派此待指派需求');
    assertDispatchRecordVersion_(pendingRecord, payload, '指派', source);

    const normalized = normalizePendingAssignmentPayload_(pendingRecord, payload, source, viewerEmail);
    assertNoOverlappingNurseDispatch_(normalized, records);
    assertTemporaryDispatchCooldown_(normalized, records);

    const now = formatTimestamp_(new Date());
    const assignedRecord = {
      ...pendingRecord,
      ...normalized,
      id: pendingRecord.id,
      createdAt: pendingRecord.createdAt,
      createdBy: pendingRecord.createdBy,
      assignmentStatus: '',
      demandCount: 1,
      version: createDispatchRecordVersion_(),
      updatedAt: now,
      updatedBy: viewerEmail,
      status: '有效'
    };
    records[targetIndex] = assignedRecord;

    saveStoredDispatchRecords_(records, context);
    appendDispatchAuditLogs_([
      buildDispatchAuditLog_('assign-pending', assignedRecord, {
        context,
        source,
        viewerEmail,
        occurredAt: now,
        previousRecord: pendingRecord
      })
    ], context);
    syncTemporaryDispatchColumn_(source, records, [normalized.assignmentKey], context);
    lock.releaseLock();
    hasLock = false;

    return getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
  } catch (error) {
    console.error('指派待指派調派需求失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法指派待指派調派需求。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function deleteWorkHourDispatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    const id = String(payload && payload.id || '').trim();
    if (!id) {
      throw new Error('缺少調派紀錄 ID。');
    }

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const records = getStoredDispatchRecords_(context);
    const targetIndex = records.findIndex((record) => record.id === id && record.status === '有效');
    if (targetIndex < 0) {
      const inactiveRecord = records.find((record) => record.id === id);
      if (inactiveRecord) {
        throw new Error(buildDispatchDeletedConflictMessage_(inactiveRecord, '刪除', source));
      }
      throw new Error('找不到要刪除的調派紀錄。請先按「重新整理」查看最新調派內容。');
    }

    const deletedRecord = records[targetIndex];
    assertCanManageStation_(context, deletedRecord.stationCode);
    assertDispatchRecordVersion_(deletedRecord, payload, '刪除', source);
    const now = formatTimestamp_(new Date());
    records.splice(targetIndex, 1);

    saveStoredDispatchRecords_(records, context);
    appendDispatchAuditLogs_([
      buildDispatchAuditLog_('delete', deletedRecord, {
        context,
        source,
        viewerEmail,
        occurredAt: now
      })
    ], context);
    syncTemporaryDispatchColumn_(source, records, [deletedRecord.assignmentKey], context);
    lock.releaseLock();
    hasLock = false;
    return getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
  } catch (error) {
    console.error('刪除工時調派失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法刪除工時調派。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function createStation(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    assertCanCreateStation_(context);
    const effectiveSource = context.viewer.testMode ? applyTestStationOverrides_(source) : source;
    const normalized = normalizeCreateStationPayload_(payload, effectiveSource);
    if (context.viewer.testMode) {
      createTestStationRecord_(source, normalized);
    } else {
      appendStationRecord_(source.orgSheet, normalized);
      ensureStationManagerAssignment_(source.assignmentSheet, source.assignments, normalized);
      invalidateDispatchSourceCache_();
    }
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
    response.createdStation = {
      code: normalized.code,
      name: normalized.alias || normalized.name,
      isExternal: normalized.isExternal
    };
    return response;
  } catch (error) {
    console.error('新增駐站失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法新增駐站。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function deleteStation(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    acquireDispatchWriteLock_(lock);
    hasLock = true;

    const source = loadDispatchSource_({ includeSheets: true, forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const stationCode = normalizeOrgCode_(payload && payload.stationCode);
    if (!stationCode) {
      throw new Error('請選擇要刪除的駐站。');
    }
    const effectiveSource = context.viewer.testMode ? applyTestStationOverrides_(source) : source;
    assertCanAdministrateStation_(context, stationCode);
    assertCanDeleteStation_(effectiveSource, stationCode, context);
    if (context.viewer.testMode) {
      deleteTestStationRecord_(source, stationCode);
    } else {
      deleteStationOrgRows_(source.orgSheet, stationCode);
      deleteStationManagerAssignmentRows_(source.assignmentSheet, stationCode);
      invalidateDispatchSourceCache_();
    }
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(buildDispatchRefreshPayload_(payload, context));
    response.deletedStationCode = stationCode;
    return response;
  } catch (error) {
    console.error('刪除駐站失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法刪除駐站。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function loadDispatchSource_(options) {
  const settings = options || {};
  const includeSheets = Boolean(settings.includeSheets);
  const forceFresh = Boolean(settings.forceFresh);

  if (!includeSheets && !forceFresh) {
    const cachedSource = getCachedDispatchSource_();
    if (cachedSource) return cachedSource;
  }

  const spreadsheet = getDispatchSourceSpreadsheet_();
  const personnelSheet = getPersonnelSheet_(spreadsheet);
  const assignmentSheet = getAssignmentSheet_(spreadsheet);
  const orgSheet = getSheetByNameOrNull_(spreadsheet, getEnvString_('DISPATCH_ORG_SHEET_NAME', APP_CONFIG.orgSheetName));
  const personnel = personnelSheet ? readPersonnelRecords_(personnelSheet) : [];
  const personnelByEmail = new Map(personnel.map((person) => [person.email, person]));
  const assignments = readAssignmentRecords_(assignmentSheet, personnelByEmail);
  const orgStations = orgSheet ? readStationRecords_(orgSheet) : [];
  const mergedStations = mergeStationsWithAssignmentGroups_(orgStations, assignments);
  const stations = mergedStations.length ? mergedStations : deriveStationsFromAssignments_(assignments);
  const source = {
    personnel,
    personnelByEmail,
    assignments,
    stations
  };

  if (includeSheets) {
    source.orgSheet = orgSheet;
    source.assignmentSheet = assignmentSheet;
  } else {
    putCachedDispatchSource_(source);
  }

  return source;
}

function getCachedDispatchSource_() {
  const cached = getCachedJson_(APP_CONFIG.sourceCacheKey);
  if (!cached || !Array.isArray(cached.assignments) || !Array.isArray(cached.stations)) return null;

  const personnel = Array.isArray(cached.personnel) ? cached.personnel : [];
  return {
    personnel,
    personnelByEmail: new Map(personnel.map((person) => [person.email, person])),
    assignments: cached.assignments,
    stations: cached.stations
  };
}

function putCachedDispatchSource_(source) {
  const personnel = Array.isArray(source.personnel)
    ? source.personnel
    : Array.from(source.personnelByEmail.values());
  putCachedJson_(APP_CONFIG.sourceCacheKey, {
    personnel,
    assignments: source.assignments || [],
    stations: source.stations || []
  }, APP_CONFIG.sourceCacheSeconds);
}

function getDispatchSourceSpreadsheet_() {
  const spreadsheetId = getDispatchSourceSpreadsheetId_();
  return SpreadsheetApp.openById(spreadsheetId);
}

function getDispatchSourceSpreadsheetId_() {
  const spreadsheetId = getEnvString_('DISPATCH_SOURCE_SHEET_ID', '');
  if (!spreadsheetId || spreadsheetId.indexOf('請填入') >= 0) {
    throw new Error('尚未設定駐站護理師調派獨立資料 Spreadsheet ID，請於 GAS 指令碼屬性 (Script Properties) 設定 DISPATCH_SOURCE_SHEET_ID。');
  }

  const chrmSpreadsheetId = getEnvString_('CHRM_MASTER_SHEET_ID', getEnvString_('MASTER_SHEET_ID', ''));
  if (chrmSpreadsheetId && spreadsheetId === chrmSpreadsheetId) {
    throw new Error('駐站護理師調派 App 不可讀取 cHRM 正式資料表，請將指令碼屬性 (Script Properties) 的 DISPATCH_SOURCE_SHEET_ID 改為獨立試算表 ID。');
  }

  return spreadsheetId;
}

// 單次執行生命週期快取 Script Properties，避免 getEnvString_ 在大量讀表時反覆打 API（Issue #14）。
var SCRIPT_PROPERTIES_CACHE_ = null;

function getScriptPropertiesCache_() {
  if (SCRIPT_PROPERTIES_CACHE_) return SCRIPT_PROPERTIES_CACHE_;
  try {
    SCRIPT_PROPERTIES_CACHE_ = PropertiesService.getScriptProperties().getProperties() || {};
  } catch (error) {
    // 本地或無權限環境取不到 Properties 時，降級為空物件並沿用 ENV fallback。
    console.error('讀取 Script Properties 失敗:', error);
    SCRIPT_PROPERTIES_CACHE_ = {};
  }
  return SCRIPT_PROPERTIES_CACHE_;
}

// 讀取優先序：Script Property → ENV[key] → fallback（Issue #14 混合模式）。
function getEnvString_(key, fallback) {
  if (!key) return fallback;
  const properties = getScriptPropertiesCache_();
  if (properties && typeof properties[key] === 'string') {
    const propValue = properties[key].trim();
    if (propValue) return propValue;
  }
  if (typeof ENV !== 'undefined' && typeof ENV[key] !== 'undefined') {
    const value = String(ENV[key] || '').trim();
    if (value) return value;
  }
  return fallback;
}

function getEnvBoolean_(key, fallback) {
  if (!key) return fallback;
  const properties = getScriptPropertiesCache_();
  if (properties && typeof properties[key] === 'string' && properties[key].trim()) {
    return parseBooleanish_(properties[key], fallback);
  }
  if (typeof ENV !== 'undefined' && ENV[key] !== undefined && ENV[key] !== null && ENV[key] !== '') {
    return parseBooleanish_(ENV[key], fallback);
  }
  return fallback;
}

function parseBooleanish_(value, fallback) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', '是', 'on'].indexOf(normalized) >= 0) return true;
  if (['false', '0', 'no', 'n', '否', 'off'].indexOf(normalized) >= 0) return false;
  return fallback;
}

function getEnvArray_(key, fallback) {
  const defaults = Array.isArray(fallback) ? fallback : [];
  if (!key) return defaults;
  const properties = getScriptPropertiesCache_();
  if (properties && typeof properties[key] === 'string' && properties[key].trim()) {
    return parseArrayish_(properties[key], defaults);
  }
  if (typeof ENV !== 'undefined' && typeof ENV[key] !== 'undefined') {
    return parseArrayish_(ENV[key], defaults);
  }
  return defaults;
}

// 同時容錯兩種來源：ENV 為真陣列、Script Properties 只能存字串（JSON 陣列或逗號／換行分隔）。
function parseArrayish_(value, defaults) {
  if (Array.isArray(value)) return value.slice();
  const raw = String(value || '').trim();
  if (!raw) return defaults;
  if (raw.charAt(0) === '[') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (error) {
      // JSON 解析失敗則落入下方分隔切分。
    }
  }
  return raw.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function getScriptCache_() {
  try {
    return CacheService.getScriptCache();
  } catch (error) {
    console.error('讀取快取服務失敗:', error);
    return null;
  }
}

function getCachedJson_(key) {
  const cache = getScriptCache_();
  if (!cache || !key) return null;

  const raw = cache.get(key);
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`解析快取資料失敗：${key}`, error);
    return null;
  }
}

function putCachedJson_(key, value, ttlSeconds) {
  const cache = getScriptCache_();
  if (!cache || !key || !ttlSeconds) return;

  const raw = JSON.stringify(value);
  if (raw.length > APP_CONFIG.cacheMaxChars) return;
  const ttl = Math.max(1, Math.min(Number(ttlSeconds || 0), 21600));
  cache.put(key, raw, ttl);
}

function removeCachedValue_(key) {
  const cache = getScriptCache_();
  if (!cache || !key) return;
  cache.remove(key);
}

function invalidateDispatchSourceCache_() {
  removeCachedValue_(APP_CONFIG.sourceCacheKey);
}

function invalidateDispatchRecordsCache_() {
  removeCachedValue_(APP_CONFIG.recordsCacheKey);
  removeCachedValue_(APP_CONFIG.testRecordsCacheKey);
}

function loadOfficialHolidayCalendarForRange_(dateFrom, dateTo) {
  const holidays = {};
  const years = getOfficialHolidayYearsForRange_(dateFrom, dateTo);

  try {
    const missingYears = [];
    years.forEach((year) => {
      const yearEntries = loadOfficialHolidayCalendarForYear_(year);
      if (!yearEntries.length) missingYears.push(year);
      yearEntries.forEach((entry) => {
        if (dateFrom && entry.date < dateFrom) return;
        if (dateTo && entry.date > dateTo) return;
        holidays[entry.date] = entry;
      });
    });

    return {
      holidays,
      source: buildOfficialHolidaySourceInfo_({
        available: !missingYears.length,
        years,
        missingYears,
        count: Object.keys(holidays).length,
        message: missingYears.length
          ? buildMissingOfficialHolidayMessage_(missingYears)
          : ''
      })
    };
  } catch (error) {
    console.error('讀取政府行政機關辦公日曆失敗:', error);
    return {
      holidays: {},
      source: buildOfficialHolidaySourceInfo_({
        available: false,
        years,
        message: error && error.message ? error.message : '無法讀取政府行政機關辦公日曆。'
      })
    };
  }
}

function loadOfficialHolidayCalendarForYear_(year) {
  const normalizedYear = Number(year || 0);
  if (!Number.isInteger(normalizedYear) || normalizedYear < 1900 || normalizedYear > 2200) return [];

  const cacheKey = `${APP_CONFIG.holidayCacheKey}:${normalizedYear}`;
  const cached = getCachedJson_(cacheKey);
  if (Array.isArray(cached)) return cached;

  const rows = getOfficialHolidayDatasetRows_();
  const entries = parseOfficialHolidayEntriesForYear_(rows, normalizedYear);
  putCachedJson_(cacheKey, entries, APP_CONFIG.holidayCacheSeconds);
  return entries;
}

function getOfficialHolidayDatasetRows_(options) {
  const forceFresh = Boolean(options && options.forceFresh);
  if (!forceFresh && Array.isArray(officialHolidayDatasetRowsCache_)) return officialHolidayDatasetRowsCache_;

  const url = getEnvString_('DISPATCH_HOLIDAY_DATA_URL', APP_CONFIG.holidayDatasetCsvUrl);
  const response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true
  });
  const statusCode = response.getResponseCode();
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`政府行政機關辦公日曆下載失敗（HTTP ${statusCode}）。`);
  }

  const csvText = response.getContentText('UTF-8').replace(/^\uFEFF/, '');
  const rows = Utilities.parseCsv(csvText);
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error('政府行政機關辦公日曆資料格式異常。');
  }

  officialHolidayDatasetRowsCache_ = rows;
  return rows;
}

function parseOfficialHolidayEntriesForYear_(rows, year) {
  const headers = (rows[0] || []).map((header) => String(header || '').replace(/^\uFEFF/, '').trim());
  const dateIndex = findHeaderIndex_(headers, ['date', '日期'], 0);
  const yearIndex = findHeaderIndex_(headers, ['year', '西元年', '年度'], 1);
  const nameIndex = findHeaderIndex_(headers, ['name', '節日', '紀念日節日名稱'], 2);
  const holidayIndex = findHeaderIndex_(headers, ['isholiday', 'isHoliday', '是否放假'], 3);
  const categoryIndex = findHeaderIndex_(headers, ['holidaycategory', 'holidayCategory', '假別', '放假類別'], 4);
  const descriptionIndex = findHeaderIndex_(headers, ['description', '備註', '說明', '放假說明'], 5);

  return rows.slice(1)
    .map((row) => {
      const date = normalizeOfficialHolidayDate_(row[dateIndex]);
      if (!date || Number(date.slice(0, 4)) !== year) return null;
      const rowYear = Number(String(row[yearIndex] || '').trim() || year);
      if (Number.isFinite(rowYear) && rowYear && rowYear !== year) return null;

      const name = normalizeOfficialHolidayText_(row[nameIndex]);
      const category = normalizeOfficialHolidayText_(row[categoryIndex]);
      const description = normalizeOfficialHolidayText_(row[descriptionIndex]);
      const isHoliday = parseOfficialHolidayFlag_(row[holidayIndex]);
      const rowText = [name, category, description].filter(Boolean).join(' ');
      const isPlainWeekend = /星期六、星期日|週末|周末/.test(category) && !name;
      const isMakeupWorkday = !isHoliday && /補行上班|補班|調整上班|上班日/.test(rowText);
      const isObservedHoliday = isHoliday && !isPlainWeekend && Boolean(
        name
        || /補假|調整放假|放假之紀念日|特定節日|國定|節日|紀念日|放假/.test(category)
        || /補假|放假/.test(description)
      );

      if (!isMakeupWorkday && !isObservedHoliday) return null;

      const kind = getOfficialHolidayKind_(isMakeupWorkday, category);
      return {
        date,
        year,
        name,
        category,
        description,
        label: getOfficialHolidayLabel_(name, category, description, kind),
        isHoliday,
        isMakeupWorkday,
        kind
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function getOfficialHolidayYearsForRange_(dateFrom, dateTo) {
  const todayYear = Number(getTodayDateString_().slice(0, 4));
  const fromYear = getYearFromDateString_(dateFrom) || todayYear;
  const toYear = getYearFromDateString_(dateTo) || fromYear;
  const startYear = Math.min(fromYear, toYear);
  const endYear = Math.max(fromYear, toYear);
  const cappedEndYear = Math.min(endYear, startYear + 10);
  const years = [];

  for (let year = startYear; year <= cappedEndYear; year += 1) {
    years.push(year);
  }
  return years.length ? years : [todayYear];
}

function getOfficialHolidayRefreshYears_(payload) {
  const explicitYears = Array.isArray(payload && payload.years)
    ? payload.years
      .map((year) => Number(year || 0))
      .filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2200)
    : [];
  if (explicitYears.length) {
    return Array.from(new Set(explicitYears)).sort((a, b) => a - b);
  }

  const currentYear = Number(getTodayDateString_().slice(0, 4));
  const lookAheadYears = Math.max(0, Number(APP_CONFIG.holidayRefreshLookAheadYears || 0));
  const years = [];
  for (let year = currentYear; year <= currentYear + lookAheadYears; year += 1) {
    years.push(year);
  }
  return years;
}

function clearOfficialHolidayCache_(years) {
  (Array.isArray(years) ? years : []).forEach((year) => {
    removeCachedValue_(`${APP_CONFIG.holidayCacheKey}:${year}`);
  });
}

function buildMissingOfficialHolidayMessage_(missingYears) {
  const years = (Array.isArray(missingYears) ? missingYears : [])
    .map((year) => Number(year || 0))
    .filter((year) => Number.isInteger(year))
    .sort((a, b) => a - b);
  const yearText = years.length ? `${years.join('、')} 年` : '該年度';
  return `官方開放資料尚未提供 ${yearText}行政機關辦公日曆；系統會每日自動檢查官方 CSV，資料發布後會自動套用。`;
}

function buildOfficialHolidayRefreshMessage_(metadata) {
  const yearResults = Array.isArray(metadata && metadata.yearResults) ? metadata.yearResults : [];
  const available = yearResults.filter((item) => item.available);
  const missingYears = Array.isArray(metadata && metadata.missingYears) ? metadata.missingYears : [];
  const availableText = available.length
    ? `已取得 ${available.map((item) => `${item.year} 年 ${item.count} 筆`).join('、')}。`
    : '';
  const missingText = missingYears.length
    ? buildMissingOfficialHolidayMessage_(missingYears)
    : '';
  return [availableText, missingText].filter(Boolean).join(' ');
}

function getOfficialHolidayRefreshMetadata_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(APP_CONFIG.holidayRefreshStoreKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('讀取官方假日刷新紀錄失敗:', error);
    return {};
  }
}

function setOfficialHolidayRefreshMetadata_(metadata) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      APP_CONFIG.holidayRefreshStoreKey,
      JSON.stringify(metadata || {})
    );
  } catch (error) {
    console.error('寫入官方假日刷新紀錄失敗:', error);
  }
}

function buildOfficialHolidaySourceInfo_(options) {
  const settings = options || {};
  const refreshMetadata = getOfficialHolidayRefreshMetadata_();
  return {
    name: '政府行政機關辦公日曆表',
    provider: '政府資料開放平臺',
    url: APP_CONFIG.holidayDatasetPageUrl,
    csvUrl: getEnvString_('DISPATCH_HOLIDAY_DATA_URL', APP_CONFIG.holidayDatasetCsvUrl),
    available: Boolean(settings.available),
    years: Array.isArray(settings.years) ? settings.years : [],
    missingYears: Array.isArray(settings.missingYears) ? settings.missingYears : [],
    count: Number(settings.count || 0),
    message: String(settings.message || '').trim(),
    refreshedAt: String(settings.refreshedAt || refreshMetadata.refreshedAt || '').trim(),
    refreshSchedule: String(settings.refreshSchedule || refreshMetadata.schedule || `每日 ${APP_CONFIG.holidayRefreshHour}:00 左右自動檢查官方 CSV`).trim()
  };
}

function getOfficialHolidayKind_(isMakeupWorkday, category) {
  if (isMakeupWorkday) return 'makeup-workday';
  if (/補假/.test(category)) return 'observed-holiday';
  if (/調整放假/.test(category)) return 'adjusted-holiday';
  if (/特定節日/.test(category)) return 'special-holiday';
  return 'holiday';
}

function getOfficialHolidayLabel_(name, category, description, kind) {
  if (name) return name;
  if (kind === 'makeup-workday') return '補班';
  if (kind === 'observed-holiday') return '補假';
  if (kind === 'adjusted-holiday') return '調整放假';
  if (/放假之紀念日/.test(category)) return '國定假日';
  if (/特定節日/.test(category)) return '特定節日';
  return category || description || '休假';
}

function normalizeOfficialHolidayDate_(value) {
  const raw = String(value || '').trim().replace(/^\uFEFF/, '');
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }

  const match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) return '';
  const year = match[1];
  const month = String(Number(match[2])).padStart(2, '0');
  const day = String(Number(match[3])).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeOfficialHolidayText_(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseOfficialHolidayFlag_(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === '是' || raw === 'true' || raw === '1' || raw === 'yes' || raw === 'y';
}

function getYearFromDateString_(value) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return 0;
  return Number(raw.slice(0, 4));
}

function acquireDispatchWriteLock_(lock) {
  try {
    lock.waitLock(APP_CONFIG.writeLockWaitMs);
  } catch (error) {
    throw new Error('目前有其他管理者正在儲存資料，請稍候幾秒後再試。系統已避免多人同時寫入造成資料覆蓋。');
  }
}

function getSheetByNameOrNull_(spreadsheet, sheetName) {
  try {
    return spreadsheet.getSheetByName(sheetName);
  } catch (error) {
    return null;
  }
}

function getSheetByGidOrNull_(spreadsheet, gid) {
  const normalizedGid = Number(gid || 0);
  if (!normalizedGid) return null;

  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    if (Number(sheets[i].getSheetId()) === normalizedGid) return sheets[i];
  }
  return null;
}

function getAssignmentSheet_(spreadsheet) {
  const gidSheet = getSheetByGidOrNull_(
    spreadsheet,
    Number(getEnvString_('DISPATCH_ASSIGNMENT_SHEET_GID', '0'))
  );
  if (gidSheet) return gidSheet;

  const namedSheet = getSheetByNameOrNull_(spreadsheet, getEnvString_('DISPATCH_ASSIGNMENT_SHEET_NAME', APP_CONFIG.assignmentSheetName));
  if (namedSheet) return namedSheet;

  const sheets = spreadsheet.getSheets();
  for (let i = 0; i < sheets.length; i += 1) {
    const values = sheets[i].getRange(1, 1, 1, Math.max(1, sheets[i].getLastColumn())).getDisplayValues()[0];
    const hasEmail = findHeaderIndex_(values, FIELD_ALIASES.email) >= 0;
    const hasOrgCode = findHeaderIndex_(values, FIELD_ALIASES.orgCode) >= 0;
    if (hasEmail && hasOrgCode) return sheets[i];
  }

  throw new Error('找不到包含「信箱」與「所屬組別代碼」欄位的人員職務配置工作表。');
}

function getPersonnelSheet_(spreadsheet) {
  const gidSheet = getSheetByGidOrNull_(
    spreadsheet,
    Number(getEnvString_('DISPATCH_PERSONNEL_SHEET_GID', '0'))
  );
  if (gidSheet) return gidSheet;
  return getSheetByNameOrNull_(spreadsheet, getEnvString_('DISPATCH_PERSONNEL_SHEET_NAME', APP_CONFIG.personnelSheetName));
}

function readPersonnelRecords_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const emailIndex = findHeaderIndex_(headers, FIELD_ALIASES.email, 0);
  const nameIndex = findHeaderIndex_(headers, FIELD_ALIASES.name, 1);
  const statusIndex = findHeaderIndex_(headers, FIELD_ALIASES.status, 2);

  return values.slice(1)
    .map((row) => ({
      email: normalizeEmail_(row[emailIndex]),
      name: String(row[nameIndex] || '').trim(),
      status: String(row[statusIndex] || '').trim()
    }))
    .filter((person) => person.email);
}

function readAssignmentRecords_(sheet, personnelByEmail) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const emailIndex = findHeaderIndex_(headers, FIELD_ALIASES.email, 0);
  const nameIndex = findHeaderIndex_(headers, FIELD_ALIASES.name, 1);
  const orgCodeIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgCode, 2);
  const orgNameIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgName, 3);
  const titleIndex = findHeaderIndex_(headers, FIELD_ALIASES.title, 4);
  const managerEmailIndex = findHeaderIndex_(headers, FIELD_ALIASES.managerEmail, 5);
  const managerNameIndex = findHeaderIndex_(headers, FIELD_ALIASES.managerName, 6);
  const statusIndex = findHeaderIndex_(headers, FIELD_ALIASES.status);
  const temporaryDispatchIndex = findHeaderIndex_(headers, FIELD_ALIASES.temporaryDispatch);

  return values.slice(1)
    .map((row, index) => {
      const email = normalizeEmail_(row[emailIndex]);
      const orgCode = normalizeOrgCode_(row[orgCodeIndex]);
      const person = personnelByEmail.get(email) || {};
      const name = String(row[nameIndex] || person.name || '').trim();
      const status = String((statusIndex >= 0 ? row[statusIndex] : '') || person.status || '').trim();

      return {
        rowIndex: index + 2,
        assignmentKey: buildAssignmentKey_(email, orgCode),
        email,
        name,
        orgCode,
        orgName: String(row[orgNameIndex] || '').trim(),
        title: String(row[titleIndex] || '').trim(),
        status,
        isUnavailable: isUnavailableStatus_(status),
        managerEmail: normalizeEmail_(row[managerEmailIndex]),
        managerName: String(row[managerNameIndex] || '').trim(),
        temporaryDispatch: temporaryDispatchIndex >= 0 ? String(row[temporaryDispatchIndex] || '').trim() : ''
      };
    })
    .filter((assignment) => assignment.email && assignment.orgCode);
}

function readStationRecords_(sheet) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const typeIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgType, 0);
  const levelIndex = findHeaderIndex_(headers, FIELD_ALIASES.level, 1);
  const codeIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgCode, 2);
  const nameIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgName, 3);
  const aliasIndex = findHeaderIndex_(headers, FIELD_ALIASES.alias, 4);
  const parentCodeIndex = findHeaderIndex_(headers, FIELD_ALIASES.parentCode, 5);
  const managerEmailIndex = findHeaderIndex_(headers, FIELD_ALIASES.managerEmail, 6);
  const managerNameIndex = findHeaderIndex_(headers, FIELD_ALIASES.managerName, 7);
  const isoIndex = findHeaderIndex_(headers, FIELD_ALIASES.iso, 8);

  return values.slice(1)
    .map((row, index) => ({
      rowIndex: index + 2,
      type: String(row[typeIndex] || '').trim(),
      level: Number(row[levelIndex] || 0),
      code: normalizeOrgCode_(row[codeIndex]),
      name: String(row[aliasIndex] || row[nameIndex] || '').trim(),
      alias: String(row[aliasIndex] || '').trim(),
      parentCode: normalizeOrgCode_(row[parentCodeIndex]),
      managerEmail: normalizeEmail_(row[managerEmailIndex]),
      managerName: String(row[managerNameIndex] || '').trim(),
      isIsoCertified: String(row[isoIndex] || '').trim().toUpperCase() === 'V',
      isExternal: isExternalStationCodeOrType_(row[codeIndex], row[typeIndex])
    }))
    .filter((station) => station.code && isStationCode_(station.code));
}

function deriveStationsFromAssignments_(assignments) {
  const stationMap = new Map();

  assignments
    .filter((assignment) => isStationCode_(assignment.orgCode))
    .forEach((assignment) => {
      if (!stationMap.has(assignment.orgCode)) {
        stationMap.set(assignment.orgCode, {
          rowIndex: 0,
          code: assignment.orgCode,
          name: assignment.orgName || assignment.orgCode,
          alias: '',
          managerEmail: assignment.managerEmail,
          managerName: assignment.managerName,
          isIsoCertified: false,
          isExternal: isExternalStationCodeOrType_(assignment.orgCode, '')
        });
      }

      const station = stationMap.get(assignment.orgCode);
      if (!station.managerEmail && assignment.managerEmail) station.managerEmail = assignment.managerEmail;
      if (!station.managerName && assignment.managerName) station.managerName = assignment.managerName;
    });

  return Array.from(stationMap.values());
}

function mergeStationsWithAssignmentGroups_(orgStations, assignments) {
  const stationMap = new Map();

  (Array.isArray(orgStations) ? orgStations : []).forEach((station) => {
    if (!station || !station.code) return;
    stationMap.set(station.code, { ...station });
  });

  deriveStationsFromAssignments_(assignments).forEach((assignmentStation) => {
    const existing = stationMap.get(assignmentStation.code) || {};
    stationMap.set(assignmentStation.code, {
      ...existing,
      ...assignmentStation,
      // 駐站顯示名稱以人員職務配置表的「所屬組別」欄為準。
      name: assignmentStation.name || existing.name || assignmentStation.code,
      managerEmail: existing.managerEmail || assignmentStation.managerEmail || '',
      managerName: existing.managerName || assignmentStation.managerName || '',
      isIsoCertified: Boolean(existing.isIsoCertified || assignmentStation.isIsoCertified),
      isExternal: Boolean(existing.isExternal || assignmentStation.isExternal)
    });
  });

  return Array.from(stationMap.values());
}

function applyTestStationOverrides_(source) {
  if (!source || typeof source !== 'object') return source;

  const hiddenStationCodes = getTestHiddenStationCodes_();
  const createdStations = getTestCreatedStations_()
    .filter((station) => station && station.code);
  const stationByCode = new Map();
  const assignments = (Array.isArray(source.assignments) ? source.assignments : [])
    .filter((assignment) => !hiddenStationCodes.has(normalizeOrgCode_(assignment && assignment.orgCode)));

  (Array.isArray(source.stations) ? source.stations : [])
    .filter((station) => station && station.code && !hiddenStationCodes.has(station.code))
    .forEach((station) => {
      stationByCode.set(station.code, { ...station });
    });

  createdStations.forEach((station) => {
    stationByCode.set(station.code, { ...station });
    assignments.push(createTestStationManagerAssignment_(station));
  });

  return {
    ...source,
    assignments,
    stations: Array.from(stationByCode.values())
  };
}

function createTestStationManagerAssignment_(station) {
  const managerEmail = normalizeEmail_(station && station.managerEmail);
  const stationCode = normalizeOrgCode_(station && station.code);
  const managerName = String(station && station.managerName || managerEmail).trim();
  return {
    rowIndex: 0,
    assignmentKey: buildAssignmentKey_(managerEmail, stationCode),
    email: managerEmail,
    name: managerName,
    orgCode: stationCode,
    orgName: String(station && (station.alias || station.name) || stationCode).trim(),
    title: APP_CONFIG.stationManagerTitle,
    status: '在職',
    isUnavailable: false,
    managerEmail,
    managerName,
    temporaryDispatch: ''
  };
}

function createTestStationRecord_(source, station) {
  const normalized = normalizeTestStationRecord_(station);
  if (!normalized) {
    throw new Error('測試駐站資料格式錯誤。');
  }

  const stations = getTestCreatedStations_()
    .filter((item) => item.code !== normalized.code);
  stations.push(normalized);
  saveTestCreatedStations_(stations);

  const isOfficialStation = (Array.isArray(source && source.stations) ? source.stations : [])
    .some((item) => item && item.code === normalized.code);
  if (!isOfficialStation) {
    const hiddenStationCodes = getTestHiddenStationCodes_();
    hiddenStationCodes.delete(normalized.code);
    saveTestHiddenStationCodes_(hiddenStationCodes);
  }
}

function deleteTestStationRecord_(source, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  if (!normalizedStationCode) {
    throw new Error('請選擇要刪除的駐站。');
  }

  const stations = getTestCreatedStations_();
  const nextStations = stations.filter((station) => station.code !== normalizedStationCode);
  saveTestCreatedStations_(nextStations);

  const isOfficialStation = (Array.isArray(source && source.stations) ? source.stations : [])
    .some((station) => station && station.code === normalizedStationCode);
  if (isOfficialStation) {
    const hiddenStationCodes = getTestHiddenStationCodes_();
    hiddenStationCodes.add(normalizedStationCode);
    saveTestHiddenStationCodes_(hiddenStationCodes);
  }
}

function getTestCreatedStations_() {
  return getScriptJsonStore_(APP_CONFIG.testStationsStoreKey)
    .map(normalizeTestStationRecord_)
    .filter(Boolean);
}

function saveTestCreatedStations_(stations) {
  const normalizedStations = (Array.isArray(stations) ? stations : [])
    .map(normalizeTestStationRecord_)
    .filter(Boolean)
    .sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant'));
  setScriptJsonStore_(APP_CONFIG.testStationsStoreKey, normalizedStations, APP_CONFIG.maxRecords);
}

function getTestHiddenStationCodes_() {
  return new Set(getScriptJsonStore_(APP_CONFIG.testHiddenStationCodesStoreKey)
    .map(normalizeOrgCode_)
    .filter(Boolean));
}

function saveTestHiddenStationCodes_(stationCodes) {
  const normalizedCodes = Array.from(stationCodes || [])
    .map(normalizeOrgCode_)
    .filter(Boolean)
    .sort();
  setScriptJsonStore_(APP_CONFIG.testHiddenStationCodesStoreKey, normalizedCodes, APP_CONFIG.maxRecords);
}

function normalizeTestStationRecord_(station) {
  if (!station || typeof station !== 'object') return null;
  const code = normalizeOrgCode_(station.code);
  const managerEmail = normalizeEmail_(station.managerEmail);
  if (!code || !managerEmail) return null;
  const isExternal = Boolean(station.isExternal || isExternalStationCodeOrType_(code, station.type || station.typeLabel));
  return {
    rowIndex: 0,
    type: String(station.type || station.typeLabel || (isExternal ? '委外駐站' : '一般駐站')).trim(),
    level: Number(station.level || getEnvString_('DISPATCH_STATION_LEVEL', '3')),
    code,
    name: String(station.name || station.alias || code).trim(),
    alias: String(station.alias || '').trim(),
    parentCode: normalizeOrgCode_(station.parentCode || getEnvString_('DISPATCH_STATION_PARENT_CODE', '')),
    managerEmail,
    managerName: String(station.managerName || managerEmail).trim(),
    isIsoCertified: Boolean(station.isIsoCertified),
    isExternal
  };
}

function buildDispatchContext_(source, viewerEmail, options) {
  const canUseTestMode = canUseTestMode_(viewerEmail, source.assignments);
  const testMode = Boolean(options && options.testMode && canUseTestMode);
  if (options && options.testMode && !canUseTestMode) {
    throw new Error('您沒有測試模式權限。');
  }
  const effectiveSource = testMode ? applyTestStationOverrides_(source) : source;
  const stationByCode = new Map(effectiveSource.stations.map((station) => [station.code, { ...station }]));
  const stationAssignments = dedupeAssignments_(effectiveSource.assignments)
    .filter((assignment) => stationByCode.has(assignment.orgCode));

  stationByCode.forEach((station) => {
    const nurseAssignments = stationAssignments
      .filter((assignment) => assignment.orgCode === station.code && isNurseAssignment_(assignment))
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email), 'zh-Hant'))
      .map((assignment) => ({
        assignmentKey: assignment.assignmentKey,
        email: assignment.email,
        name: assignment.name,
        title: assignment.title,
        status: assignment.status || '',
        isUnavailable: Boolean(assignment.isUnavailable),
        availabilityLabel: getAvailabilityLabel_(assignment),
        orgCode: assignment.orgCode,
        orgName: assignment.orgName || station.name
      }));
    station.members = nurseAssignments.filter((assignment) => !assignment.isUnavailable);
    station.unavailableMembers = nurseAssignments.filter((assignment) => assignment.isUnavailable);
    station.memberCount = station.members.length;
    station.unavailableMemberCount = station.unavailableMembers.length;
  });

  const managedStationCodes = new Set();
  Array.from(stationByCode.values()).forEach((station) => {
    if (normalizeEmail_(station.managerEmail) === viewerEmail) {
      managedStationCodes.add(station.code);
    }
  });
  stationAssignments
    .filter((assignment) => (
      normalizeEmail_(assignment.managerEmail) === viewerEmail
      || (normalizeEmail_(assignment.email) === viewerEmail && isStationManagerAssignment_(assignment))
    ))
    .forEach((assignment) => {
      managedStationCodes.add(assignment.orgCode);
    });
  const managedStations = Array.from(stationByCode.values())
    .filter((station) => testMode || managedStationCodes.has(station.code));
  const isStationManager = managedStations.length > 0;
  const dispatchStations = isStationManager
    ? Array.from(stationByCode.values())
    : managedStations;
  const visibleStationCodes = new Set(dispatchStations.map((station) => station.code));
  const canUseExternalSources = Boolean(testMode || isStationManager);
  const visibleNurses = stationAssignments
    .filter((assignment) => (
      isNurseAssignment_(assignment)
      && (canUseExternalSources || visibleStationCodes.has(assignment.orgCode))
    ))
    .map((assignment) => {
      const station = stationByCode.get(assignment.orgCode) || {};
      return {
        assignmentKey: assignment.assignmentKey,
        email: assignment.email,
        name: assignment.name,
        title: assignment.title,
        status: assignment.status || '',
        isUnavailable: Boolean(assignment.isUnavailable),
        availabilityLabel: getAvailabilityLabel_(assignment),
        orgCode: assignment.orgCode,
        orgName: assignment.orgName || station.name || assignment.orgCode
      };
    })
    .sort(compareNurses_);

  const viewerPerson = effectiveSource.personnelByEmail.get(viewerEmail) || {};
  const viewerAssignment = effectiveSource.assignments.find((assignment) => assignment.email === viewerEmail) || {};

  return {
    viewer: {
      email: viewerEmail,
      name: String(viewerPerson.name || viewerAssignment.name || '').trim(),
      isStationManager,
      canUseTestMode,
      canCreateStation: isStationManager || canUseTestMode,
      managedStationCodes: Array.from(managedStationCodes),
      testMode
    },
    managedStationCodes,
    stations: dispatchStations
      .sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant'))
      .map((station) => ({
        code: station.code,
        name: station.name || station.code,
        isExternal: Boolean(station.isExternal),
        managerEmail: normalizeEmail_(station.managerEmail),
        managerName: station.managerName || '',
        memberCount: Number(station.memberCount || 0),
        unavailableMemberCount: Number(station.unavailableMemberCount || 0),
        members: station.members || []
      })),
    nurses: visibleNurses
  };
}

function compareNurses_(a, b) {
  if (Boolean(a.isUnavailable) !== Boolean(b.isUnavailable)) {
    return a.isUnavailable ? 1 : -1;
  }
  const nameCompare = String(a.name || a.email).localeCompare(String(b.name || b.email), 'zh-Hant');
  if (nameCompare !== 0) return nameCompare;
  const orgCompare = String(a.orgName || a.orgCode).localeCompare(String(b.orgName || b.orgCode), 'zh-Hant');
  if (orgCompare !== 0) return orgCompare;
  return String(a.email || '').localeCompare(String(b.email || ''));
}

function dedupeAssignments_(assignments) {
  const map = new Map();
  assignments.forEach((assignment) => {
    if (!assignment.assignmentKey || map.has(assignment.assignmentKey)) return;
    map.set(assignment.assignmentKey, assignment);
  });
  return Array.from(map.values());
}

function isNurseAssignment_(assignment) {
  const title = String(assignment.title || '').trim();
  return title === '收案人員';
}

function isUnavailableStatus_(status) {
  const normalized = String(status || '').replace(/\s+/g, '');
  if (!normalized || normalized === '在職' || normalized === '正常') return false;
  return APP_CONFIG.unavailableStatusKeywords.some((keyword) => normalized.indexOf(keyword) >= 0);
}

function getAvailabilityLabel_(assignment) {
  if (!assignment || !assignment.isUnavailable) return '';
  return assignment.status ? `${assignment.status}，不可調配` : '不可調配';
}

function isStationManagerAssignment_(assignment) {
  const title = String(assignment && assignment.title || '').trim();
  return [
    '駐站管理員',
    '駐站管理人員',
    '管理員',
    '管理人員',
    '收案管理員',
    '收案管理人員'
  ].includes(title);
}

function normalizeDispatchMode_(value) {
  const normalized = String(value || '').trim();
  if (normalized === '行動收案') return '行動收案';
  return '正常班';
}

function isMobileCaseDispatch_(shiftName) {
  return normalizeDispatchMode_(shiftName) === '行動收案';
}

function canUseTestMode_(viewerEmail, assignments) {
  const normalizedViewerEmail = normalizeEmail_(viewerEmail);
  if (!normalizedViewerEmail) return false;
  if (getTesterEmails_().includes(normalizedViewerEmail)) return true;

  const testerTitles = getTesterTitles_();
  return (Array.isArray(assignments) ? assignments : []).some((assignment) => (
    normalizeEmail_(assignment.email) === normalizedViewerEmail
    && testerTitles.includes(String(assignment.title || '').trim())
  ));
}

function getTesterEmails_() {
  return getEnvArray_('TESTER_EMAILS', []).map((email) => normalizeEmail_(email)).filter(Boolean);
}

function getTesterTitles_() {
  const titles = getEnvArray_('TESTER_TITLES', ['系統測試人員', '測試人員'])
    .map((title) => String(title || '').trim())
    .filter(Boolean);
  return titles.length ? titles : ['系統測試人員', '測試人員'];
}

function buildStationManagerCandidates_(source) {
  const candidateMap = new Map();

  (source && Array.isArray(source.assignments) ? source.assignments : []).forEach((assignment) => {
    if (!assignment || !assignment.email || !isStrictStationManagerAssignment_(assignment)) return;
    const person = source && source.personnelByEmail
      ? source.personnelByEmail.get(assignment.email)
      : null;
    const existing = candidateMap.get(assignment.email);
    const status = String((person && person.status) || assignment.status || '').trim();
    if (isUnavailableStatus_(status)) return;

    candidateMap.set(assignment.email, {
      email: assignment.email,
      name: String((person && person.name) || assignment.name || assignment.email).trim(),
      status,
      title: APP_CONFIG.stationManagerTitle,
      orgCodes: mergeUniqueValues_(existing && existing.orgCodes, assignment.orgCode),
      orgNames: mergeUniqueValues_(existing && existing.orgNames, assignment.orgName)
    });
  });

  return Array.from(candidateMap.values())
    .filter((person) => person.email)
    .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email), 'zh-Hant'));
}

function isStrictStationManagerAssignment_(assignment) {
  return String(assignment && assignment.title || '').trim() === APP_CONFIG.stationManagerTitle;
}

function mergeUniqueValues_(values, nextValue) {
  const nextValues = Array.isArray(values) ? values.slice() : [];
  const normalizedNextValue = String(nextValue || '').trim();
  if (normalizedNextValue && !nextValues.includes(normalizedNextValue)) {
    nextValues.push(normalizedNextValue);
  }
  return nextValues;
}

function assertCanCreateStation_(context) {
  const canCreate = Boolean(context && context.viewer && context.viewer.canCreateStation);
  if (!canCreate) {
    throw new Error('您沒有新增駐站的權限。');
  }
}

function assertCanManageStation_(context, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const canManage = context.stations.some((station) => station.code === normalizedStationCode);
  if (!canManage) {
    throw new Error('您沒有管理此駐站工時調派的權限。');
  }
}

function assertCanAdministrateStation_(context, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const canAdministrate = Boolean(context && context.viewer && context.viewer.testMode)
    || Boolean(context && context.managedStationCodes && context.managedStationCodes.has(normalizedStationCode));
  if (!canAdministrate) {
    throw new Error('您沒有刪除此駐站管理資料的權限。共享調度僅開放工時調派，駐站資料仍限原管理者維護。');
  }
}

function assertCanManageRelatedStation_(context, stationCode, originalStationCode, actionLabel) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const normalizedOriginalStationCode = normalizeOrgCode_(originalStationCode);
  const canManage = context.stations.some((station) => (
    station.code === normalizedStationCode
    || station.code === normalizedOriginalStationCode
  ));
  if (!canManage) {
    throw new Error(`您沒有${actionLabel || '管理此調派需求'}的權限。`);
  }
}

function normalizeCreateStationPayload_(payload, source) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('新增駐站資料格式錯誤。');
  }
  if (!source || !source.orgSheet) {
    throw new Error('找不到組織架構樹工作表，無法新增駐站。');
  }

  const stationType = String(payload.stationType || 'general').trim() === 'external' ? 'external' : 'general';
  const isExternal = stationType === 'external';
  const suffix = normalizeStationCodeSuffix_(payload.codeSuffix, isExternal);
  const prefix = isExternal ? APP_CONFIG.externalStationCodePrefix : APP_CONFIG.stationCodePrefix;
  const code = `${prefix}${suffix}`;

  if ((source.stations || []).some((station) => normalizeOrgCode_(station.code) === code)) {
    throw new Error(`駐站代碼 ${code} 已存在。`);
  }

  const name = normalizeShortText_(payload.name, '駐站中文名稱', 80);
  if (!name) {
    throw new Error('請輸入駐站中文名稱。');
  }
  const alias = normalizeShortText_(payload.alias || '', '駐站別名', 40);
  const managerEmail = normalizeEmail_(payload.managerEmail);
  if (!managerEmail) {
    throw new Error('請選擇駐站管理員。');
  }

  const candidates = buildStationManagerCandidates_(source);
  const manager = candidates.find((person) => person.email === managerEmail);
  if (!manager) {
    throw new Error('找不到職稱為「駐站管理員」的人選，請先確認人員職務配置表。');
  }

  return {
    stationType,
    isExternal,
    typeLabel: isExternal ? '委外駐站' : '一般駐站',
    code,
    name,
    alias,
    managerEmail,
    managerName: manager.name || manager.email,
    isIsoCertified: Boolean(payload.isIsoCertified)
  };
}

function normalizeStationCodeSuffix_(value, isExternal) {
  let suffix = String(value || '').trim().toUpperCase();
  suffix = suffix
    .replace(new RegExp(`^${escapeRegExp_(APP_CONFIG.externalStationCodePrefix)}`), '')
    .replace(new RegExp(`^${escapeRegExp_(APP_CONFIG.stationCodePrefix)}`), '');
  if (!suffix) {
    throw new Error('請輸入英文尾碼。');
  }
  if (isExternal && suffix.indexOf('EX-') === 0) {
    suffix = suffix.slice(3);
  }
  if (!/^[A-Z0-9][A-Z0-9-]{0,23}$/.test(suffix)) {
    throw new Error('英文尾碼只能使用大寫英文、數字與連字號，長度最多 24 碼。');
  }
  if (!isExternal && suffix.indexOf('EX-') === 0) {
    throw new Error('一般駐站英文尾碼不可用 EX- 開頭，請切換為委外駐站。');
  }
  return suffix;
}

function appendStationRecord_(sheet, station) {
  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0];
  const columnCount = Math.max(sheet.getLastColumn(), 9);
  const row = new Array(columnCount).fill('');
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.orgType, 0)] = station.typeLabel;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.level, 1)] = getEnvString_('DISPATCH_STATION_LEVEL', '3');
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.orgCode, 2)] = station.code;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.orgName, 3)] = station.name;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.alias, 4)] = station.alias;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.parentCode, 5)] = getEnvString_('DISPATCH_STATION_PARENT_CODE', '');
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.managerEmail, 6)] = station.managerEmail;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.managerName, 7)] = station.managerName;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.iso, 8)] = station.isIsoCertified ? 'V' : '';
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function ensureStationManagerAssignment_(sheet, assignments, station) {
  const hasManagerAssignment = (Array.isArray(assignments) ? assignments : []).some((assignment) => (
    normalizeEmail_(assignment.email) === station.managerEmail
    && normalizeOrgCode_(assignment.orgCode) === station.code
    && isStationManagerAssignment_(assignment)
  ));
  if (hasManagerAssignment) return;

  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0];
  const columnCount = Math.max(sheet.getLastColumn(), 9);
  const row = new Array(columnCount).fill('');
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.email, 0)] = station.managerEmail;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.name, 1)] = station.managerName;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.orgCode, 2)] = station.code;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.orgName, 3)] = station.alias || station.name;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.title, 4)] = APP_CONFIG.stationManagerTitle;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.managerEmail, 5)] = station.managerEmail;
  row[getWritableColumnIndex_(headers, FIELD_ALIASES.managerName, 6)] = station.managerName;
  const statusIndex = findHeaderIndex_(headers, FIELD_ALIASES.status);
  if (statusIndex >= 0) row[statusIndex] = '在職';
  const temporaryDispatchIndex = findHeaderIndex_(headers, FIELD_ALIASES.temporaryDispatch);
  if (temporaryDispatchIndex >= 0) row[temporaryDispatchIndex] = '';
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
}

function assertCanDeleteStation_(source, stationCode, options) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const activeRecords = getStoredDispatchRecords_(options)
    .filter((record) => (
      record.status === '有效'
      && (record.stationCode === normalizedStationCode || record.originalStationCode === normalizedStationCode)
    ));
  if (activeRecords.length) {
    throw new Error('此駐站已有有效調派紀錄，請先刪除或調整相關工時調派後再刪除駐站。');
  }

  const nurseAssignments = (source && Array.isArray(source.assignments) ? source.assignments : [])
    .filter((assignment) => (
      assignment.orgCode === normalizedStationCode
      && isNurseAssignment_(assignment)
    ));
  if (nurseAssignments.length) {
    throw new Error('此駐站仍有人員配置，不可直接刪除。請先移除人員職務配置。');
  }
}

function deleteStationOrgRows_(sheet, stationCode) {
  if (!sheet) {
    throw new Error('找不到組織架構樹工作表，無法刪除駐站。');
  }
  const rowIndexes = findRowsByOrgCode_(sheet, stationCode);
  if (!rowIndexes.length) {
    throw new Error('找不到組織架構樹中的駐站列，無法刪除。');
  }
  deleteRowsDescending_(sheet, rowIndexes);
}

function deleteStationManagerAssignmentRows_(sheet, stationCode) {
  if (!sheet) return;
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return;

  const headers = values[0];
  const orgCodeIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgCode, 2);
  const titleIndex = findHeaderIndex_(headers, FIELD_ALIASES.title, 4);
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const rowIndexes = [];

  values.slice(1).forEach((row, index) => {
    const orgCode = normalizeOrgCode_(row[orgCodeIndex]);
    const title = String(row[titleIndex] || '').trim();
    if (orgCode === normalizedStationCode && isStationManagerAssignment_({ title })) {
      rowIndexes.push(index + 2);
    }
  });

  deleteRowsDescending_(sheet, rowIndexes);
}

function findRowsByOrgCode_(sheet, stationCode) {
  const values = sheet.getDataRange().getDisplayValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const orgCodeIndex = findHeaderIndex_(headers, FIELD_ALIASES.orgCode, 2);
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const rowIndexes = [];

  values.slice(1).forEach((row, index) => {
    if (normalizeOrgCode_(row[orgCodeIndex]) === normalizedStationCode) {
      rowIndexes.push(index + 2);
    }
  });
  return rowIndexes;
}

function deleteRowsDescending_(sheet, rowIndexes) {
  (Array.isArray(rowIndexes) ? rowIndexes : [])
    .slice()
    .sort((a, b) => b - a)
    .forEach((rowIndex) => sheet.deleteRow(rowIndex));
}

function getWritableColumnIndex_(headers, aliases, fallbackIndex) {
  const index = findHeaderIndex_(headers, aliases, fallbackIndex);
  if (index < 0) {
    throw new Error(`找不到必要欄位：${aliases[0]}`);
  }
  return index;
}

function normalizeWorkHourPayload_(payload, context, viewerEmail) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('工時調派資料格式錯誤。');
  }

  const id = String(payload.id || '').trim();
  const startDate = normalizeDate_(payload.startDate || payload.workDate, '調派起日');
  const endDate = normalizeDate_(payload.endDate || payload.workDate || startDate, '調派迄日');
  if (endDate < startDate) {
    throw new Error('調派迄日不可早於調派起日。');
  }
  const stationCode = normalizeOrgCode_(payload.stationCode);
  const station = context.stations.find((item) => item.code === stationCode);
  if (!station) {
    throw new Error('請選擇有效的調派目標駐站。');
  }
  const shiftName = normalizeDispatchMode_(payload.shiftName || APP_CONFIG.shiftOptions[0]);
  const isMobileCaseDispatch = isMobileCaseDispatch_(shiftName);
  const isExternalTarget = isExternalStation_(station);
  if (isExternalTarget) {
    assertSundayToThursdayDispatchDateRange_(startDate, endDate, '委外駐站');
  }
  if (isMobileCaseDispatch) {
    assertSundayToThursdayDispatchDateRange_(startDate, endDate, '行動收案');
  }

  const assignmentKey = String(payload.assignmentKey || '').trim();
  const member = (context.nurses || []).find((item) => item.assignmentKey === assignmentKey);
  if (!member) {
    throw new Error('找不到可調派的護理師配置。');
  }
  if (member.isUnavailable) {
    throw new Error(`${member.name || member.email} 目前狀態為「${member.status || '不可調配'}」，不得調派。`);
  }
  const originalStationCode = normalizeOrgCode_(member.orgCode);
  const originalStationName = String(member.orgName || originalStationCode).trim();
  const isTemporaryDispatch = Boolean(originalStationCode && originalStationCode !== station.code);
  const isTestMode = Boolean(context && context.viewer && context.viewer.testMode);
  if (!isTestMode && !isTemporaryDispatch && !isExternalTarget && !isMobileCaseDispatch && context.managedStationCodes && !context.managedStationCodes.has(member.orgCode)) {
    throw new Error('正常班只能調派自己管理範圍內的護理師。');
  }

  const startTime = normalizeTime_(payload.startTime);
  const endTime = normalizeTime_(payload.endTime);
  const hours = normalizeHours_(payload.hours, startTime, endTime);
  const note = normalizeShortText_(payload.note || '', '備註', 300);
  const dispatchDays = countDateRangeDays_(startDate, endDate);
  const dispatchTotalHours = calculateDispatchTotalHours_(hours, dispatchDays);

  return {
    id,
    workDate: startDate,
    startDate,
    endDate,
    stationCode,
    stationName: station.name || station.code,
    assignmentKey,
    nurseEmail: member.email,
    nurseName: member.name || member.email,
    nurseTitle: member.title || '',
    originalStationCode,
    originalStationName,
    temporaryDispatchLabel: isTemporaryDispatch ? '臨時調配' : '',
    dispatchDays,
    dispatchTotalHours,
    shiftName,
    startTime,
    endTime,
    hours,
    note,
    updatedBy: viewerEmail
  };
}

function normalizePendingWorkHourPayload_(payload, source, context, viewerEmail) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('待指派需求資料格式錯誤。');
  }

  const startDate = normalizeDate_(payload.startDate || payload.workDate, '調派起日');
  const endDate = normalizeDate_(payload.endDate || payload.workDate || startDate, '調派迄日');
  if (endDate < startDate) {
    throw new Error('調派迄日不可早於調派起日。');
  }
  const stationCode = normalizeOrgCode_(payload.stationCode);
  const station = context.stations.find((item) => item.code === stationCode);
  if (!station) {
    throw new Error('請選擇有效的待指派目標駐站。');
  }
  const originalStationCode = normalizeOrgCode_(payload.originalStationCode || payload.sourceStationCode);
  const originalStation = findSourceStationByCode_(source, originalStationCode);
  if (!originalStation) {
    throw new Error('請選擇有效的來源駐站。');
  }
  if (originalStation.code === station.code) {
    throw new Error('待指派需求需選擇不同的來源駐站與調派駐站。');
  }

  const shiftName = normalizeDispatchMode_(payload.shiftName || APP_CONFIG.shiftOptions[0]);
  const isMobileCaseDispatch = isMobileCaseDispatch_(shiftName);
  const isExternalTarget = isExternalStation_(station);
  if (isExternalTarget) {
    assertSundayToThursdayDispatchDateRange_(startDate, endDate, '委外駐站');
  }
  if (isMobileCaseDispatch) {
    assertSundayToThursdayDispatchDateRange_(startDate, endDate, '行動收案');
  }

  const startTime = normalizeTime_(payload.startTime);
  const endTime = normalizeTime_(payload.endTime);
  const hours = normalizeHours_(payload.hours, startTime, endTime);
  const note = normalizeShortText_(payload.note || '', '備註', 300);
  const dispatchDays = countDateRangeDays_(startDate, endDate);

  return {
    id: '',
    workDate: startDate,
    startDate,
    endDate,
    stationCode,
    stationName: station.name || station.code,
    assignmentKey: '',
    nurseEmail: '',
    nurseName: APP_CONFIG.pendingDispatchNurseName,
    nurseTitle: '',
    originalStationCode: originalStation.code,
    originalStationName: originalStation.name || originalStation.code,
    temporaryDispatchLabel: '臨時調配',
    assignmentStatus: APP_CONFIG.pendingAssignmentStatus,
    demandCount: 1,
    dispatchDays,
    dispatchTotalHours: calculateDispatchTotalHours_(hours, dispatchDays),
    shiftName,
    startTime,
    endTime,
    hours,
    note,
    updatedBy: viewerEmail
  };
}

function normalizePendingAssignmentPayload_(pendingRecord, payload, source, viewerEmail) {
  const assignmentKey = String(payload && payload.assignmentKey || '').trim();
  if (!assignmentKey) {
    throw new Error('請選擇要指派的護理師。');
  }
  const assignment = findNurseAssignmentByKey_(source, assignmentKey);
  if (!assignment) {
    throw new Error('找不到可指派的護理師配置。');
  }
  if (assignment.isUnavailable) {
    throw new Error(`${assignment.name || assignment.email} 目前狀態為「${assignment.status || '不可調配'}」，不得調派。`);
  }
  if (normalizeOrgCode_(assignment.orgCode) !== normalizeOrgCode_(pendingRecord.originalStationCode)) {
    throw new Error('確定人選必須屬於這筆需求的來源駐站。');
  }

  return {
    id: pendingRecord.id,
    workDate: pendingRecord.startDate,
    startDate: pendingRecord.startDate,
    endDate: pendingRecord.endDate,
    stationCode: pendingRecord.stationCode,
    stationName: pendingRecord.stationName,
    assignmentKey: assignment.assignmentKey,
    nurseEmail: assignment.email,
    nurseName: assignment.name || assignment.email,
    nurseTitle: assignment.title || '',
    originalStationCode: pendingRecord.originalStationCode,
    originalStationName: pendingRecord.originalStationName,
    temporaryDispatchLabel: '臨時調配',
    dispatchDays: getDispatchDays_(pendingRecord),
    dispatchTotalHours: getDispatchTotalHours_(pendingRecord),
    shiftName: pendingRecord.shiftName,
    startTime: pendingRecord.startTime,
    endTime: pendingRecord.endTime,
    hours: pendingRecord.hours,
    note: normalizeShortText_(pendingRecord.note || '', '備註', 300),
    updatedBy: viewerEmail
  };
}

function findSourceStationByCode_(source, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  if (!normalizedStationCode) return null;
  return (Array.isArray(source && source.stations) ? source.stations : [])
    .find((station) => station && station.code === normalizedStationCode) || null;
}

function findNurseAssignmentByKey_(source, assignmentKey) {
  const normalizedAssignmentKey = String(assignmentKey || '').trim();
  if (!normalizedAssignmentKey) return null;
  return (Array.isArray(source && source.assignments) ? source.assignments : [])
    .find((assignment) => (
      assignment
      && assignment.assignmentKey === normalizedAssignmentKey
      && isNurseAssignment_(assignment)
    )) || null;
}

function assertNoDuplicatePendingDispatchDemand_(target, records) {
  const duplicate = normalizeActiveStoredDispatchRecords_(records)
    .filter((record) => (
      isPendingAssignmentRecord_(record)
      && record.stationCode === target.stationCode
      && record.originalStationCode === target.originalStationCode
      && record.startDate === target.startDate
      && record.endDate === target.endDate
      && record.shiftName === target.shiftName
    ))[0];
  if (!duplicate) return;
  throw new Error('已有相同期間、來源駐站與調派駐站的待指派需求。若需要多人，請先確認第一筆後再新增下一筆。');
}

function assertSundayToThursdayDispatchDateRange_(startDate, endDate, label) {
  const blockedDates = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    const day = new Date(`${cursor}T00:00:00+08:00`).getDay();
    if (day === 5 || day === 6) blockedDates.push(cursor);
    cursor = addDays_(cursor, 1);
  }
  if (blockedDates.length) {
    throw new Error(`${label || '此模式'}僅可安排週日到週四，請移除週五或週六日期：${blockedDates.join('、')}`);
  }
}

function normalizeDispatchFilters_(payload) {
  const today = getTodayDateString_();
  const defaultFrom = addDays_(today, -APP_CONFIG.defaultRangeDays + 1);
  const dateFrom = String(payload && payload.dateFrom || defaultFrom).trim();
  const dateTo = String(payload && payload.dateTo || today).trim();

  return {
    dateFrom: /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) ? dateFrom : defaultFrom,
    dateTo: /^\d{4}-\d{2}-\d{2}$/.test(dateTo) ? dateTo : today,
    stationCode: normalizeOrgCode_(payload && payload.stationCode),
    nurseEmail: normalizeEmail_(payload && payload.nurseEmail)
  };
}

function buildDispatchRefreshPayload_(payload, context) {
  return {
    ...((payload && payload.filters && typeof payload.filters === 'object') ? payload.filters : {}),
    testMode: Boolean(context && context.viewer && context.viewer.testMode)
  };
}

function loadDispatchRecords_(allowedStationCodes, filters, options) {
  return getStoredDispatchRecords_(options)
    .filter((record) => {
      if (record.status !== '有效') return false;
      if (allowedStationCodes) {
        const allowedTarget = allowedStationCodes.has(record.stationCode);
        const allowedOriginal = Boolean(options && options.includeOriginalStation)
          && allowedStationCodes.has(record.originalStationCode);
        if (!allowedTarget && !allowedOriginal) return false;
      }
      if (filters.stationCode && record.stationCode !== filters.stationCode) return false;
      if (filters.nurseEmail && normalizeEmail_(record.nurseEmail) !== filters.nurseEmail) return false;
      if (filters.dateFrom && record.endDate < filters.dateFrom) return false;
      if (filters.dateTo && record.startDate > filters.dateTo) return false;
      return true;
    })
    .map((record) => applyDispatchRecordAvailability_(record, options && options.assignmentAvailabilityByKey))
    .sort(compareDispatchRecords_);
}

function buildAssignmentAvailabilityByKey_(assignments) {
  const map = new Map();
  (Array.isArray(assignments) ? assignments : []).forEach((assignment) => {
    if (!assignment || !assignment.assignmentKey || map.has(assignment.assignmentKey)) return;
    map.set(assignment.assignmentKey, {
      status: assignment.status || '',
      isUnavailable: Boolean(assignment.isUnavailable)
    });
  });
  return map;
}

function applyDispatchRecordAvailability_(record, assignmentAvailabilityByKey) {
  const availability = assignmentAvailabilityByKey && assignmentAvailabilityByKey.get(record.assignmentKey);
  if (!availability) return record;
  return {
    ...record,
    nurseStatus: availability.status || '',
    isNurseUnavailable: Boolean(availability.isUnavailable)
  };
}

function assertNoOverlappingNurseDispatch_(target, records) {
  const conflict = normalizeActiveStoredDispatchRecords_(records)
    .filter((record) => (
      record.assignmentKey === target.assignmentKey
      && record.id !== target.id
      && dateRangesOverlap_(record.startDate, record.endDate, target.startDate, target.endDate)
    ))
    .sort(compareDispatchRecords_)[0];

  if (!conflict) return;

  throw new Error([
    `同一位護理師在重疊期間不可重複調派：${target.nurseName || target.nurseEmail || '未命名人員'}。`,
    `既有調派：${formatDispatchDateRange_(conflict.startDate, conflict.endDate)} ${conflict.stationName || conflict.stationCode}`,
    `本次調派：${formatDispatchDateRange_(target.startDate, target.endDate)} ${target.stationName || target.stationCode}`
  ].join('\n'));
}

function assertTemporaryDispatchCooldown_(target, records) {
  if (!isTemporaryDispatchRecord_(target)) return;

  const conflict = normalizeActiveStoredDispatchRecords_(records)
    .filter((record) => (
      record.assignmentKey === target.assignmentKey
      && record.id !== target.id
      && isTemporaryDispatchRecord_(record)
      && !hasTemporaryDispatchCooldownGap_(record, target)
    ))
    .sort(compareTemporaryDispatchCooldownConflicts_(target))[0];

  if (!conflict) return;

  const nextAllowedDate = getNextTemporaryDispatchAllowedDate_(conflict, target);
  throw new Error([
    `臨時調派間隔未滿 ${APP_CONFIG.temporaryDispatchCooldownDays} 天：${target.nurseName || target.nurseEmail || '未命名人員'}。`,
    `既有臨時調派：${formatDispatchDateRange_(conflict.startDate, conflict.endDate)} ${conflict.originalStationName || conflict.originalStationCode} → ${conflict.stationName || conflict.stationCode}`,
    `本次臨時調派：${formatDispatchDateRange_(target.startDate, target.endDate)} ${target.originalStationName || target.originalStationCode} → ${target.stationName || target.stationCode}`,
    nextAllowedDate ? `下一次最早可安排日期：${nextAllowedDate}` : ''
  ].filter(Boolean).join('\n'));
}

function buildFairnessStationStats_(records, stations) {
  const stationMap = new Map();
  (Array.isArray(stations) ? stations : []).forEach((station) => {
    if (!station || !station.code) return;
    stationMap.set(station.code, createFairnessStationStat_(station.code, station.name || station.code));
  });

  normalizeActiveStoredDispatchRecords_(records).forEach((record) => {
    const days = getDispatchDays_(record);
    const hours = getDispatchTotalHours_(record);
    const targetCode = normalizeOrgCode_(record.stationCode);
    const sourceCode = normalizeOrgCode_(record.originalStationCode);
    if (targetCode) {
      const targetStat = getFairnessStationStat_(stationMap, targetCode, record.stationName || targetCode);
      targetStat.incomingCount += 1;
      targetStat.incomingDays += days;
      targetStat.incomingPersonDays += days;
      targetStat.incomingHours += hours;
      if (record.assignmentKey) targetStat.nurseKeys.add(record.assignmentKey);
    }
    if (sourceCode) {
      const sourceStat = getFairnessStationStat_(stationMap, sourceCode, record.originalStationName || sourceCode);
      sourceStat.outgoingCount += 1;
      sourceStat.outgoingDays += days;
      sourceStat.outgoingPersonDays += days;
      sourceStat.outgoingHours += hours;
      if (record.assignmentKey) sourceStat.nurseKeys.add(record.assignmentKey);
    }
  });

  return Array.from(stationMap.values())
    .filter((stat) => stat.incomingCount || stat.outgoingCount)
    .map((stat) => ({
      stationCode: stat.stationCode,
      stationName: stat.stationName,
      incomingCount: stat.incomingCount,
      outgoingCount: stat.outgoingCount,
      totalCount: stat.incomingCount + stat.outgoingCount,
      incomingDays: stat.incomingDays,
      outgoingDays: stat.outgoingDays,
      incomingPersonDays: stat.incomingPersonDays,
      outgoingPersonDays: stat.outgoingPersonDays,
      totalPersonDays: stat.incomingPersonDays + stat.outgoingPersonDays,
      incomingHours: Math.round(stat.incomingHours * 100) / 100,
      outgoingHours: Math.round(stat.outgoingHours * 100) / 100,
      nurseCount: stat.nurseKeys.size
    }))
    .sort((a, b) => {
      const personDayCompare = Number(b.totalPersonDays || 0) - Number(a.totalPersonDays || 0);
      if (personDayCompare !== 0) return personDayCompare;
      const countCompare = Number(b.totalCount || 0) - Number(a.totalCount || 0);
      if (countCompare !== 0) return countCompare;
      return String(a.stationName || a.stationCode).localeCompare(String(b.stationName || b.stationCode), 'zh-Hant');
    });
}

function createFairnessStationStat_(stationCode, stationName) {
  return {
    stationCode,
    stationName,
    incomingCount: 0,
    outgoingCount: 0,
    incomingDays: 0,
    outgoingDays: 0,
    incomingPersonDays: 0,
    outgoingPersonDays: 0,
    incomingHours: 0,
    outgoingHours: 0,
    nurseKeys: new Set()
  };
}

function getFairnessStationStat_(stationMap, stationCode, stationName) {
  if (!stationMap.has(stationCode)) {
    stationMap.set(stationCode, createFairnessStationStat_(stationCode, stationName || stationCode));
  }
  return stationMap.get(stationCode);
}

function buildFairnessNurseStats_(records) {
  const nurseMap = new Map();
  normalizeActiveStoredDispatchRecords_(records).forEach((record) => {
    const key = record.assignmentKey || record.nurseEmail || record.nurseName;
    if (!key) return;
    if (!nurseMap.has(key)) {
      nurseMap.set(key, {
        assignmentKey: record.assignmentKey || '',
        nurseName: record.nurseName || record.nurseEmail || '',
        nurseEmail: record.nurseEmail || '',
        originalStationCode: record.originalStationCode || '',
        originalStationName: record.originalStationName || '',
        dispatchCount: 0,
        dispatchDays: 0,
        dispatchHours: 0,
        targetStationNames: new Set(),
        latestEndDate: ''
      });
    }
    const stat = nurseMap.get(key);
    stat.dispatchCount += 1;
    stat.dispatchDays += getDispatchDays_(record);
    stat.dispatchHours += getDispatchTotalHours_(record);
    if (record.stationName || record.stationCode) stat.targetStationNames.add(record.stationName || record.stationCode);
    if (!stat.latestEndDate || String(record.endDate || '') > stat.latestEndDate) {
      stat.latestEndDate = String(record.endDate || '');
    }
  });

  return Array.from(nurseMap.values())
    .map((stat) => ({
      assignmentKey: stat.assignmentKey,
      nurseName: stat.nurseName,
      nurseEmail: stat.nurseEmail,
      originalStationCode: stat.originalStationCode,
      originalStationName: stat.originalStationName,
      dispatchCount: stat.dispatchCount,
      dispatchDays: stat.dispatchDays,
      dispatchHours: Math.round(stat.dispatchHours * 100) / 100,
      targetStationSummary: Array.from(stat.targetStationNames).sort((a, b) => String(a).localeCompare(String(b), 'zh-Hant')).join('、'),
      latestEndDate: stat.latestEndDate,
      nextAllowedDate: stat.latestEndDate ? addDays_(stat.latestEndDate, APP_CONFIG.temporaryDispatchCooldownDays) : ''
    }))
    .sort((a, b) => {
      const countCompare = Number(b.dispatchCount || 0) - Number(a.dispatchCount || 0);
      if (countCompare !== 0) return countCompare;
      return String(a.nurseName || a.nurseEmail).localeCompare(String(b.nurseName || b.nurseEmail), 'zh-Hant');
    });
}

function isTemporaryDispatchRecord_(record) {
  const originalCode = normalizeOrgCode_(record && record.originalStationCode);
  const stationCode = normalizeOrgCode_(record && record.stationCode);
  return Boolean(originalCode && stationCode && originalCode !== stationCode);
}

function isPendingAssignmentRecord_(record) {
  return normalizeAssignmentStatus_(record && record.assignmentStatus) === APP_CONFIG.pendingAssignmentStatus;
}

function normalizeAssignmentStatus_(value) {
  const normalized = String(value || '').trim();
  return normalized === APP_CONFIG.pendingAssignmentStatus ? APP_CONFIG.pendingAssignmentStatus : '';
}

function hasTemporaryDispatchCooldownGap_(existing, target) {
  if (!existing || !target) return true;
  const cooldownDays = Number(APP_CONFIG.temporaryDispatchCooldownDays || 0);
  if (!cooldownDays) return true;
  if (dateRangesOverlap_(existing.startDate, existing.endDate, target.startDate, target.endDate)) return false;

  if (existing.endDate < target.startDate) {
    return target.startDate >= addDays_(existing.endDate, cooldownDays);
  }

  if (target.endDate < existing.startDate) {
    return existing.startDate >= addDays_(target.endDate, cooldownDays);
  }

  return true;
}

function getNextTemporaryDispatchAllowedDate_(existing, target) {
  if (!existing || !target) return '';
  if (existing.endDate <= target.startDate) {
    return addDays_(existing.endDate, APP_CONFIG.temporaryDispatchCooldownDays);
  }
  if (target.endDate < existing.startDate) {
    return addDays_(target.endDate, APP_CONFIG.temporaryDispatchCooldownDays);
  }
  return addDays_(existing.endDate, APP_CONFIG.temporaryDispatchCooldownDays);
}

function compareTemporaryDispatchCooldownConflicts_(target) {
  return (a, b) => {
    const distanceA = getDateRangeDistanceDays_(a, target);
    const distanceB = getDateRangeDistanceDays_(b, target);
    if (distanceA !== distanceB) return distanceA - distanceB;
    return compareDispatchRecords_(a, b);
  };
}

function getDateRangeDistanceDays_(left, right) {
  if (dateRangesOverlap_(left.startDate, left.endDate, right.startDate, right.endDate)) return 0;
  if (left.endDate < right.startDate) return getDateDifferenceDays_(left.endDate, right.startDate);
  if (right.endDate < left.startDate) return getDateDifferenceDays_(right.endDate, left.startDate);
  return 0;
}

function getDateDifferenceDays_(fromDate, toDate) {
  const from = new Date(`${fromDate}T00:00:00+08:00`);
  const to = new Date(`${toDate}T00:00:00+08:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  return Math.abs(Math.round((to.getTime() - from.getTime()) / 86400000));
}

function dateRangesOverlap_(leftStart, leftEnd, rightStart, rightEnd) {
  const normalizedLeftStart = String(leftStart || '').trim();
  const normalizedLeftEnd = String(leftEnd || leftStart || '').trim();
  const normalizedRightStart = String(rightStart || '').trim();
  const normalizedRightEnd = String(rightEnd || rightStart || '').trim();
  if (!normalizedLeftStart || !normalizedLeftEnd || !normalizedRightStart || !normalizedRightEnd) return false;
  return normalizedLeftStart <= normalizedRightEnd && normalizedLeftEnd >= normalizedRightStart;
}

function assertDispatchRecordVersion_(record, payload, actionLabel, source) {
  const clientVersion = String(payload && payload.recordVersion || '').trim();
  const serverVersion = String(record && record.version || '').trim();
  if (!serverVersion || clientVersion === serverVersion) return;
  if (!clientVersion) {
    throw new Error(buildMissingDispatchVersionMessage_(record, actionLabel));
  }

  throw new Error(buildDispatchVersionConflictMessage_(record, actionLabel, source));
}

function buildMissingDispatchVersionMessage_(record, actionLabel) {
  const rangeText = formatDispatchDateRange_(record.startDate, record.endDate);
  const nurseText = record.nurseName || record.nurseEmail || '這位護理師';
  const stationText = record.stationName || record.stationCode || '這個駐站';

  return [
    `目前畫面上的 ${rangeText} ${nurseText} 到 ${stationText} 調派資料不是最新版本。`,
    `為避免覆蓋其他管理者可能已調整的班表，系統未執行本次${actionLabel}。`,
    '請先按「重新整理」查看最新調派內容，再決定是否重新編輯。'
  ].join('\n');
}

function buildDispatchVersionConflictMessage_(record, actionLabel, source) {
  const operator = getDispatchOperatorDisplay_(record, source);
  const updatedAt = String(record.updatedAt || '').trim() || '剛剛';
  const rangeText = formatDispatchDateRange_(record.startDate, record.endDate);
  const nurseText = record.nurseName || record.nurseEmail || '這位護理師';
  const stationText = record.stationName || record.stationCode || '這個駐站';

  return [
    `這筆 ${rangeText} ${nurseText} 到 ${stationText} 的調派，已由 ${operator} 於 ${updatedAt} 更新。`,
    `為避免覆蓋其他管理者剛調整的班表，系統未執行本次${actionLabel}。`,
    '請先按「重新整理」查看最新調派內容，再決定是否重新編輯。'
  ].join('\n');
}

function buildDispatchDeletedConflictMessage_(record, actionLabel, source) {
  const operator = getDispatchOperatorDisplay_(record, source);
  const updatedAt = String(record.updatedAt || '').trim() || '剛剛';
  const rangeText = formatDispatchDateRange_(record.startDate, record.endDate);
  const nurseText = record.nurseName || record.nurseEmail || '這位護理師';
  const stationText = record.stationName || record.stationCode || '這個駐站';

  return [
    `這筆 ${rangeText} ${nurseText} 到 ${stationText} 的調派，已由 ${operator} 於 ${updatedAt} 刪除。`,
    `為避免把已取消的班表重新寫入，系統未執行本次${actionLabel}。`,
    '請先按「重新整理」查看最新調派內容，再決定是否需要新增一筆調派。'
  ].join('\n');
}

function getDispatchOperatorDisplay_(record, source) {
  const email = normalizeEmail_(record && record.updatedBy);
  const person = source && source.personnelByEmail && email
    ? source.personnelByEmail.get(email)
    : null;
  const name = String(person && person.name || '').trim();
  if (name && email) return `${name}（${email}）`;
  if (name) return name;
  return email || '其他管理者';
}

function createDispatchRecordVersion_() {
  return Utilities.getUuid();
}

function buildLegacyDispatchRecordVersion_(record) {
  return [
    record && record.id,
    record && (record.updatedAt || record.createdAt),
    record && (record.updatedBy || record.createdBy),
    record && record.status
  ].map((value) => String(value || '').trim()).join('|');
}

function syncTemporaryDispatchColumn_(source, records, assignmentKeys, options) {
  // 預設為同步（true），僅當明確設為 false 時跳過；支援 Script Properties 與 env.js 兩種來源（Issue #14）。
  if (!getEnvBoolean_('SYNC_TEMPORARY_DISPATCH_COLUMN', true)) return;
  if (isTestDispatchRecordStore_(options)) return;
  if (!source || !source.assignmentSheet) return;

  const keys = Array.from(new Set((assignmentKeys || [])
    .map((key) => String(key || '').trim())
    .filter(Boolean)));
  if (!keys.length) return;

  const sheet = source.assignmentSheet;
  const headers = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getDisplayValues()[0];
  const temporaryDispatchIndex = findHeaderIndex_(headers, FIELD_ALIASES.temporaryDispatch);
  if (temporaryDispatchIndex < 0) {
    throw new Error('找不到「臨時調配」欄，無法同步標註。');
  }

  const assignmentsByKey = new Map((source.assignments || []).map((assignment) => [assignment.assignmentKey, assignment]));
  let didWrite = false;
  keys.forEach((assignmentKey) => {
    const assignment = assignmentsByKey.get(assignmentKey);
    if (!assignment || !assignment.rowIndex) return;

    const value = buildTemporaryDispatchCellValue_(records, assignmentKey, source);
    sheet.getRange(Number(assignment.rowIndex), temporaryDispatchIndex + 1).setValue(value);
    didWrite = true;
  });
  if (didWrite) invalidateDispatchSourceCache_();
}

function buildTemporaryDispatchCellValue_(records, assignmentKey, source) {
  const activeTemporaryRecords = normalizeActiveStoredDispatchRecords_(records)
    .filter((record) => (
      record.assignmentKey === assignmentKey
      && record.originalStationCode
      && record.stationCode
      && record.originalStationCode !== record.stationCode
    ))
    .sort(compareDispatchRecords_);

  if (!activeTemporaryRecords.length) return '';

  const limitedRecords = activeTemporaryRecords.slice(0, 20);
  const countTerms = limitedRecords.map(() => '1');
  const hourTerms = limitedRecords.map((record) => formatNumber_(getDispatchTotalHours_(record)));
  const countTotal = countTerms.length;
  const hourTotal = limitedRecords.reduce((sum, record) => sum + getDispatchTotalHours_(record), 0);
  const summaryLines = [
    `臨調次數：${countTerms.join('+')}=${countTotal}`,
    `臨調時數：${hourTerms.join('+')}=${formatNumber_(hourTotal)}h`
  ];
  const detailLines = limitedRecords.map((record) => {
    const dateText = formatDispatchDateRange_(record.startDate, record.endDate).replace(/-/g, '/');
    const operatorText = formatTemporaryDispatchCellOperator_(record, source);
    return [
      '臨調',
      dateText,
      record.nurseName || record.nurseEmail,
      `${formatNumber_(getDispatchDays_(record))}天/${formatNumber_(getDispatchTotalHours_(record))}h`,
      `原:${record.originalStationName || record.originalStationCode}`,
      `至:${record.stationName || record.stationCode}`,
      operatorText
    ].filter(Boolean).join(' ');
  });
  return summaryLines.concat(detailLines).join('\n');
}

function formatTemporaryDispatchCellOperator_(record, source) {
  const operator = getDispatchOperatorDisplay_(record, source);
  const updatedAt = String(record && (record.updatedAt || record.createdAt) || '').trim();
  if (!operator && !updatedAt) return '';
  return `操作:${[operator, updatedAt].filter(Boolean).join(' ')}`;
}

function getStoredDispatchRecords_(options) {
  const store = getDispatchRecordStoreKeys_(options);
  const hasLegacyRecords = hasScriptJsonStoreData_(store.storeKey);
  const cachedRecords = getCachedJson_(store.recordsCacheKey);
  if (Array.isArray(cachedRecords) && !hasLegacyRecords) {
    return normalizeActiveStoredDispatchRecords_(cachedRecords);
  }

  migrateLegacyDispatchRecordsToAnnualSheets_(store);
  const records = readAnnualDispatchRecords_(store);
  putCachedJson_(store.recordsCacheKey, records, APP_CONFIG.recordsCacheSeconds);
  return records;
}

function saveStoredDispatchRecords_(records, options) {
  const store = getDispatchRecordStoreKeys_(options);
  migrateLegacyDispatchRecordsToAnnualSheets_(store);
  const normalized = normalizeActiveStoredDispatchRecords_(records)
    .sort(compareDispatchRecords_);
  writeAnnualDispatchRecords_(normalized, store);
  removeCachedValue_(store.recordsCacheKey);
  putCachedJson_(store.recordsCacheKey, normalized, APP_CONFIG.recordsCacheSeconds);
}

function appendDispatchAuditLogs_(logs, options) {
  try {
    const normalizedLogs = (Array.isArray(logs) ? logs : [logs])
      .map(normalizeDispatchAuditLog_)
      .filter(Boolean);
    if (!normalizedLogs.length) return;

    const store = getDispatchRecordStoreKeys_(options);
    migrateLegacyDispatchAuditLogsToAnnualSheets_(store);
    const existingLogs = readAnnualDispatchAuditLogs_(store);
    const mergedLogs = normalizedLogs
      .concat(existingLogs)
      .sort(compareDispatchAuditLogs_);
    writeAnnualDispatchAuditLogs_(mergedLogs, store);
  } catch (error) {
    console.error('寫入調派操作紀錄失敗:', error);
  }
}

function getDispatchAuditLogs_(allowedStationCodes, filters, options) {
  const store = getDispatchRecordStoreKeys_(options);
  const normalizedFilters = filters || {};
  migrateLegacyDispatchAuditLogsToAnnualSheets_(store);
  return readAnnualDispatchAuditLogs_(store)
    .filter((log) => {
      if (allowedStationCodes) {
        const allowedTarget = allowedStationCodes.has(log.stationCode);
        const allowedOriginal = allowedStationCodes.has(log.originalStationCode);
        if (!allowedTarget && !allowedOriginal) return false;
      }
      if (normalizedFilters.stationCode && log.stationCode !== normalizedFilters.stationCode && log.originalStationCode !== normalizedFilters.stationCode) return false;
      if (normalizedFilters.nurseEmail && normalizeEmail_(log.nurseEmail) !== normalizedFilters.nurseEmail) return false;
      const startDate = log.startDate || log.actionDate || '';
      const endDate = log.endDate || startDate;
      const actionDate = log.actionDate || '';
      const inDispatchRange = startDate && endDate && dateRangesOverlap_(startDate, endDate, normalizedFilters.dateFrom, normalizedFilters.dateTo);
      const inActionRange = actionDate
        && (!normalizedFilters.dateFrom || actionDate >= normalizedFilters.dateFrom)
        && (!normalizedFilters.dateTo || actionDate <= normalizedFilters.dateTo);
      if ((normalizedFilters.dateFrom || normalizedFilters.dateTo) && !inDispatchRange && !inActionRange) return false;
      return true;
    })
    .sort(compareDispatchAuditLogs_);
}

function getDispatchRecordStoreKeys_(options) {
  const testMode = isTestDispatchRecordStore_(options);
  return {
    storeKey: testMode ? APP_CONFIG.testStoreKey : APP_CONFIG.storeKey,
    recordsCacheKey: testMode ? APP_CONFIG.testRecordsCacheKey : APP_CONFIG.recordsCacheKey,
    auditLogStoreKey: testMode ? APP_CONFIG.testAuditLogStoreKey : APP_CONFIG.auditLogStoreKey,
    recordSheetPrefix: testMode ? APP_CONFIG.testRecordSheetPrefix : APP_CONFIG.recordSheetPrefix,
    auditLogSheetPrefix: testMode ? APP_CONFIG.testAuditLogSheetPrefix : APP_CONFIG.auditLogSheetPrefix
  };
}

function isTestDispatchRecordStore_(options) {
  if (!options) return false;
  if (options.viewer && options.viewer.testMode) return true;
  return Boolean(options.testMode);
}

function migrateLegacyDispatchRecordsToAnnualSheets_(store) {
  if (!store || !hasScriptJsonStoreData_(store.storeKey)) return;
  const legacyRecords = getScriptJsonStore_(store.storeKey)
    .map(normalizeStoredDispatchRecord_)
    .filter(isActiveStoredDispatchRecord_);
  if (legacyRecords.length) {
    const annualRecords = readAnnualDispatchRecords_(store);
    writeAnnualDispatchRecords_(legacyRecords.concat(annualRecords), store);
  }
  clearScriptJsonStore_(store.storeKey);
  removeCachedValue_(store.recordsCacheKey);
}

function migrateLegacyDispatchAuditLogsToAnnualSheets_(store) {
  if (!store || !hasScriptJsonStoreData_(store.auditLogStoreKey)) return;
  const legacyLogs = getScriptJsonStore_(store.auditLogStoreKey)
    .map(normalizeDispatchAuditLog_)
    .filter(Boolean);
  if (legacyLogs.length) {
    const annualLogs = readAnnualDispatchAuditLogs_(store);
    writeAnnualDispatchAuditLogs_(legacyLogs.concat(annualLogs), store);
  }
  clearScriptJsonStore_(store.auditLogStoreKey);
}

function readAnnualDispatchRecords_(store) {
  const records = [];
  getAnnualJsonStoreYears_(store.recordSheetPrefix).forEach((year) => {
    records.push(...readAnnualJsonStore_(store.recordSheetPrefix, year, normalizeStoredDispatchRecord_));
  });
  return mergeDispatchRecordsById_(records)
    .filter(isActiveStoredDispatchRecord_)
    .sort(compareDispatchRecords_);
}

function writeAnnualDispatchRecords_(records, store) {
  const normalizedRecords = mergeDispatchRecordsById_(records)
    .filter(isActiveStoredDispatchRecord_)
    .sort(compareDispatchRecords_);
  const years = new Set(getAnnualJsonStoreYears_(store.recordSheetPrefix));
  normalizedRecords.forEach((record) => years.add(getDispatchRecordAnnualYear_(record)));
  Array.from(years)
    .sort()
    .forEach((year) => {
      const recordsForYear = normalizedRecords
        .filter((record) => getDispatchRecordAnnualYear_(record) === year)
        .slice(0, APP_CONFIG.maxDispatchRecordsPerYear);
      writeAnnualJsonStore_(store.recordSheetPrefix, year, recordsForYear, normalizeStoredDispatchRecord_, compareDispatchRecords_, APP_CONFIG.maxDispatchRecordsPerYear);
    });
}

function readAnnualDispatchAuditLogs_(store) {
  const logs = [];
  getAnnualJsonStoreYears_(store.auditLogSheetPrefix).forEach((year) => {
    logs.push(...readAnnualJsonStore_(store.auditLogSheetPrefix, year, normalizeDispatchAuditLog_));
  });
  return mergeDispatchAuditLogsById_(logs)
    .sort(compareDispatchAuditLogs_);
}

function writeAnnualDispatchAuditLogs_(logs, store) {
  const normalizedLogs = mergeDispatchAuditLogsById_(logs)
    .sort(compareDispatchAuditLogs_);
  const years = new Set(getAnnualJsonStoreYears_(store.auditLogSheetPrefix));
  normalizedLogs.forEach((log) => years.add(getDispatchAuditLogAnnualYear_(log)));
  Array.from(years)
    .sort()
    .forEach((year) => {
      const logsForYear = normalizedLogs
        .filter((log) => getDispatchAuditLogAnnualYear_(log) === year)
        .slice(0, APP_CONFIG.maxDispatchAuditLogsPerYear);
      writeAnnualJsonStore_(store.auditLogSheetPrefix, year, logsForYear, normalizeDispatchAuditLog_, compareDispatchAuditLogs_, APP_CONFIG.maxDispatchAuditLogsPerYear);
    });
}

function mergeDispatchRecordsById_(records) {
  const byId = new Map();
  (Array.isArray(records) ? records : []).forEach((record) => {
    const normalized = normalizeStoredDispatchRecord_(record);
    if (!normalized || !normalized.id) return;
    byId.set(normalized.id, normalized);
  });
  return Array.from(byId.values());
}

function mergeDispatchAuditLogsById_(logs) {
  const byId = new Map();
  (Array.isArray(logs) ? logs : []).forEach((log) => {
    const normalized = normalizeDispatchAuditLog_(log);
    if (!normalized || !normalized.id) return;
    byId.set(normalized.id, normalized);
  });
  return Array.from(byId.values());
}

function readAnnualJsonStore_(sheetPrefix, year, normalizeFn) {
  const sheet = getAnnualJsonStoreSheet_(sheetPrefix, year, false);
  if (!sheet || sheet.getLastRow() < 2) return [];

  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, DISPATCH_ANNUAL_STORE_HEADERS_.length).getValues();
  return values
    .map((row) => {
      const raw = String(row[2] || '').trim();
      if (!raw) return null;
      try {
        return normalizeFn(JSON.parse(raw));
      } catch (error) {
        console.error(`解析年度調派資料失敗：${sheet.getName()}`, error);
        return null;
      }
    })
    .filter(Boolean);
}

function writeAnnualJsonStore_(sheetPrefix, year, items, normalizeFn, compareFn, maxItems) {
  const normalizedYear = normalizeAnnualStoreYear_(year);
  const normalizedItems = (Array.isArray(items) ? items : [])
    .map(normalizeFn)
    .filter(Boolean)
    .sort(compareFn)
    .slice(0, Math.max(0, Number(maxItems || 0)));
  const existingSheet = getAnnualJsonStoreSheet_(sheetPrefix, normalizedYear, false);
  if (!normalizedItems.length && !existingSheet) return;

  const sheet = existingSheet || getAnnualJsonStoreSheet_(sheetPrefix, normalizedYear, true);
  ensureAnnualJsonStoreHeader_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, DISPATCH_ANNUAL_STORE_HEADERS_.length).clearContent();
  }
  if (!normalizedItems.length) return;

  ensureSheetCapacity_(sheet, normalizedItems.length + 1, DISPATCH_ANNUAL_STORE_HEADERS_.length);
  const updatedAt = formatTimestamp_(new Date());
  const rows = normalizedItems.map((item) => [
    normalizedYear,
    getAnnualJsonItemId_(item),
    JSON.stringify(item),
    updatedAt
  ]);
  sheet.getRange(2, 1, rows.length, DISPATCH_ANNUAL_STORE_HEADERS_.length).setValues(rows);
}

function getAnnualJsonStoreYears_(sheetPrefix) {
  const spreadsheet = getDispatchSourceSpreadsheet_();
  const pattern = new RegExp(`^${escapeRegExp_(sheetPrefix)}(\\d{4})$`);
  return spreadsheet.getSheets()
    .map((sheet) => {
      const matched = String(sheet.getName() || '').match(pattern);
      return matched ? Number(matched[1]) : 0;
    })
    .filter((year) => Number.isInteger(year) && year >= 2020 && year <= 2100)
    .sort((a, b) => a - b);
}

function getAnnualJsonStoreSheet_(sheetPrefix, year, createIfMissing) {
  const normalizedYear = normalizeAnnualStoreYear_(year);
  const sheetName = `${sheetPrefix}${normalizedYear}`;
  const spreadsheet = getDispatchSourceSpreadsheet_();
  let sheet = getSheetByNameOrNull_(spreadsheet, sheetName);
  if (!sheet && createIfMissing) {
    sheet = spreadsheet.insertSheet(sheetName);
    try {
      sheet.hideSheet();
    } catch (error) {
      console.error(`隱藏年度調派資料表失敗：${sheetName}`, error);
    }
    ensureAnnualJsonStoreHeader_(sheet);
  }
  if (sheet) ensureAnnualJsonStoreHeader_(sheet);
  return sheet;
}

function ensureAnnualJsonStoreHeader_(sheet) {
  if (!sheet) return;
  ensureSheetCapacity_(sheet, 1, DISPATCH_ANNUAL_STORE_HEADERS_.length);
  const currentHeaders = sheet.getRange(1, 1, 1, DISPATCH_ANNUAL_STORE_HEADERS_.length).getDisplayValues()[0]
    .map((header) => String(header || '').trim());
  const needsHeader = DISPATCH_ANNUAL_STORE_HEADERS_.some((header, index) => currentHeaders[index] !== header);
  if (needsHeader) {
    sheet.getRange(1, 1, 1, DISPATCH_ANNUAL_STORE_HEADERS_.length).setValues([DISPATCH_ANNUAL_STORE_HEADERS_]);
    sheet.setFrozenRows(1);
  }
}

function ensureSheetCapacity_(sheet, minRows, minColumns) {
  if (!sheet) return;
  const targetRows = Math.max(1, Number(minRows || 1));
  const targetColumns = Math.max(1, Number(minColumns || 1));
  if (sheet.getMaxRows() < targetRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), targetRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < targetColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), targetColumns - sheet.getMaxColumns());
  }
}

function getAnnualJsonItemId_(item) {
  return String(item && (item.id || item.recordId || buildLegacyDispatchRecordVersion_(item)) || '').trim();
}

function getDispatchRecordAnnualYear_(record) {
  return getYearFromDateString_(record && (record.startDate || record.workDate || record.endDate))
    || normalizeAnnualStoreYear_(getTodayDateString_().slice(0, 4));
}

function getDispatchAuditLogAnnualYear_(log) {
  return getYearFromDateString_(log && (log.actionDate || log.occurredAt || log.startDate || log.endDate))
    || normalizeAnnualStoreYear_(getTodayDateString_().slice(0, 4));
}

function getYearFromDateString_(value) {
  const matched = String(value || '').trim().match(/^(\d{4})/);
  const year = matched ? Number(matched[1]) : 0;
  return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : 0;
}

function normalizeAnnualStoreYear_(value) {
  const year = Number(value || getTodayDateString_().slice(0, 4));
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error('年度調派資料表年份格式錯誤。');
  }
  return year;
}

function buildDispatchAuditLog_(action, record, options) {
  const settings = options || {};
  const viewerEmail = normalizeEmail_(settings.viewerEmail);
  const source = settings.source || {};
  const operatorPerson = source.personnelByEmail && viewerEmail
    ? source.personnelByEmail.get(viewerEmail)
    : null;
  const previousRecord = settings.previousRecord || null;
  const occurredAt = String(settings.occurredAt || formatTimestamp_(new Date())).trim();
  const actionDate = occurredAt.slice(0, 10);

  return {
    id: Utilities.getUuid(),
    action: normalizeAuditAction_(action),
    actionLabel: getDispatchAuditActionLabel_(action),
    occurredAt,
    actionDate,
    operatorEmail: viewerEmail,
    operatorName: String(operatorPerson && operatorPerson.name || '').trim(),
    testMode: Boolean(settings.context && settings.context.viewer && settings.context.viewer.testMode),
    recordId: String(record && record.id || '').trim(),
    recordVersion: String(record && record.version || '').trim(),
    stationCode: normalizeOrgCode_(record && record.stationCode),
    stationName: String(record && (record.stationName || record.stationCode) || '').trim(),
    originalStationCode: normalizeOrgCode_(record && record.originalStationCode),
    originalStationName: String(record && (record.originalStationName || record.originalStationCode) || '').trim(),
    assignmentKey: String(record && record.assignmentKey || '').trim(),
    nurseEmail: normalizeEmail_(record && record.nurseEmail),
    nurseName: String(record && (record.nurseName || record.nurseEmail) || '').trim(),
    startDate: String(record && (record.startDate || record.workDate) || '').trim(),
    endDate: String(record && (record.endDate || record.workDate || record.startDate) || '').trim(),
    shiftName: normalizeDispatchMode_(record && record.shiftName || APP_CONFIG.shiftOptions[0]),
    dispatchDays: Number(record && record.dispatchDays || countDateRangeDays_(record && record.startDate, record && record.endDate)),
    assignmentStatus: normalizeAssignmentStatus_(record && record.assignmentStatus),
    demandCount: Math.max(1, Number(record && record.demandCount || 1)),
    note: String(record && record.note || '').trim(),
    previousSummary: previousRecord ? buildDispatchAuditRecordSummary_(previousRecord) : ''
  };
}

function buildDispatchAuditRecordSummary_(record) {
  return [
    formatDispatchDateRange_(record && record.startDate, record && record.endDate),
    record && (record.originalStationName || record.originalStationCode) ? `原：${record.originalStationName || record.originalStationCode}` : '',
    record && (record.stationName || record.stationCode) ? `至：${record.stationName || record.stationCode}` : '',
    record && (record.nurseName || record.nurseEmail) ? `人員：${record.nurseName || record.nurseEmail}` : '',
    record && record.assignmentStatus ? `狀態：${record.assignmentStatus}` : ''
  ].filter(Boolean).join('｜');
}

function normalizeAuditAction_(action) {
  const normalized = String(action || '').trim();
  return [
    'create',
    'update',
    'delete',
    'create-pending',
    'assign-pending'
  ].includes(normalized) ? normalized : 'update';
}

function getDispatchAuditActionLabel_(action) {
  const normalized = normalizeAuditAction_(action);
  const labels = {
    create: '建立調派',
    update: '修改調派',
    delete: '刪除調派',
    'create-pending': '建立待指派需求',
    'assign-pending': '確認待指派人選'
  };
  return labels[normalized] || '調派異動';
}

function normalizeDispatchAuditLog_(log) {
  if (!log || typeof log !== 'object') return null;
  const occurredAt = String(log.occurredAt || '').trim();
  const stationCode = normalizeOrgCode_(log.stationCode);
  const originalStationCode = normalizeOrgCode_(log.originalStationCode);
  const recordId = String(log.recordId || '').trim();
  if (!occurredAt || !recordId || (!stationCode && !originalStationCode)) return null;
  const action = normalizeAuditAction_(log.action);
  const startDate = String(log.startDate || '').trim();
  const endDate = String(log.endDate || startDate).trim();
  const dispatchDays = Number(log.dispatchDays || countDateRangeDays_(startDate, endDate));

  return {
    id: String(log.id || buildLegacyDispatchRecordVersion_(log) || Utilities.getUuid()).trim(),
    action,
    actionLabel: String(log.actionLabel || getDispatchAuditActionLabel_(action)).trim(),
    occurredAt,
    actionDate: String(log.actionDate || occurredAt.slice(0, 10)).trim(),
    operatorEmail: normalizeEmail_(log.operatorEmail),
    operatorName: String(log.operatorName || '').trim(),
    testMode: Boolean(log.testMode),
    recordId,
    recordVersion: String(log.recordVersion || '').trim(),
    stationCode,
    stationName: String(log.stationName || stationCode).trim(),
    originalStationCode,
    originalStationName: String(log.originalStationName || originalStationCode).trim(),
    assignmentKey: String(log.assignmentKey || '').trim(),
    nurseEmail: normalizeEmail_(log.nurseEmail),
    nurseName: String(log.nurseName || log.nurseEmail || '').trim(),
    startDate,
    endDate,
    shiftName: normalizeDispatchMode_(log.shiftName || APP_CONFIG.shiftOptions[0]),
    dispatchDays: Number.isFinite(dispatchDays) && dispatchDays > 0 ? dispatchDays : 0,
    assignmentStatus: normalizeAssignmentStatus_(log.assignmentStatus),
    demandCount: Math.max(1, Number(log.demandCount || 1)),
    note: String(log.note || '').trim(),
    previousSummary: String(log.previousSummary || '').trim()
  };
}

function compareDispatchAuditLogs_(a, b) {
  const timeCompare = String(b && b.occurredAt || '').localeCompare(String(a && a.occurredAt || ''));
  if (timeCompare !== 0) return timeCompare;
  return String(b && b.id || '').localeCompare(String(a && a.id || ''));
}

function normalizeStoredDispatchRecord_(record) {
  if (!record || typeof record !== 'object') return null;
  const stationCode = normalizeOrgCode_(record.stationCode);
  const nurseEmail = normalizeEmail_(record.nurseEmail);
  const assignmentStatus = normalizeAssignmentStatus_(record.assignmentStatus);
  const isPendingAssignment = assignmentStatus === APP_CONFIG.pendingAssignmentStatus;
  const assignmentKey = isPendingAssignment
    ? String(record.assignmentKey || '').trim()
    : String(record.assignmentKey || buildAssignmentKey_(nurseEmail, stationCode)).trim();
  const startDate = String(record.startDate || record.workDate || '').trim();
  const rawEndDate = String(record.endDate || record.workDate || startDate).trim();
  const endDate = rawEndDate < startDate ? startDate : rawEndDate;
  if (!record.id || !startDate || !endDate || !stationCode) return null;
  if (!isPendingAssignment && (!nurseEmail || !assignmentKey)) return null;

  const dispatchDays = Number(record.dispatchDays || countDateRangeDays_(startDate, endDate));
  const startTime = String(record.startTime || '').trim();
  const endTime = String(record.endTime || '').trim();
  const hours = normalizeStoredHours_(record.hours, startTime, endTime);
  const originalStationCode = normalizeOrgCode_(record.originalStationCode || stationCode);
  if (isPendingAssignment && !originalStationCode) return null;

  return {
    id: String(record.id || '').trim(),
    version: String(record.version || buildLegacyDispatchRecordVersion_(record)).trim(),
    workDate: startDate,
    startDate,
    endDate,
    stationCode,
    stationName: String(record.stationName || stationCode).trim(),
    assignmentKey,
    nurseEmail,
    nurseName: String(record.nurseName || (isPendingAssignment ? APP_CONFIG.pendingDispatchNurseName : nurseEmail)).trim(),
    nurseTitle: String(record.nurseTitle || '').trim(),
    originalStationCode,
    originalStationName: String(record.originalStationName || record.stationName || stationCode).trim(),
    temporaryDispatchLabel: String(record.temporaryDispatchLabel || '').trim(),
    assignmentStatus,
    demandCount: Math.max(1, Number(record.demandCount || 1)),
    dispatchDays,
    dispatchTotalHours: calculateDispatchTotalHours_(hours, dispatchDays),
    shiftName: normalizeDispatchMode_(record.shiftName || APP_CONFIG.shiftOptions[0]),
    startTime,
    endTime,
    hours,
    note: String(record.note || '').trim(),
    createdAt: String(record.createdAt || '').trim(),
    createdBy: normalizeEmail_(record.createdBy),
    updatedAt: String(record.updatedAt || '').trim(),
    updatedBy: normalizeEmail_(record.updatedBy),
    status: String(record.status || '有效').trim() || '有效'
  };
}

function isActiveStoredDispatchRecord_(record) {
  return Boolean(record && record.status === '有效');
}

function normalizeActiveStoredDispatchRecords_(records) {
  return (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter(isActiveStoredDispatchRecord_);
}

function getScriptJsonStore_(baseKey) {
  const properties = PropertiesService.getScriptProperties();
  const chunkCount = Number(properties.getProperty(`${baseKey}:chunkCount`) || 0);
  let raw = '';

  for (let index = 0; index < chunkCount; index += 1) {
    raw += properties.getProperty(`${baseKey}:chunk:${index}`) || '';
  }

  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`解析儲存資料失敗：${baseKey}`, error);
    return [];
  }
}

function hasScriptJsonStoreData_(baseKey) {
  if (!baseKey) return false;
  const properties = PropertiesService.getScriptProperties();
  return Number(properties.getProperty(`${baseKey}:chunkCount`) || 0) > 0;
}

function setScriptJsonStore_(baseKey, records, maxRecords) {
  const normalizedRecords = Array.isArray(records) ? records.slice(0, maxRecords) : [];
  const raw = JSON.stringify(normalizedRecords);
  const chunks = [];

  for (let index = 0; index < raw.length; index += APP_CONFIG.chunkSize) {
    chunks.push(raw.slice(index, index + APP_CONFIG.chunkSize));
  }

  const properties = PropertiesService.getScriptProperties();
  const previousChunkCount = Number(properties.getProperty(`${baseKey}:chunkCount`) || 0);
  const values = {};
  values[`${baseKey}:chunkCount`] = String(chunks.length);
  chunks.forEach((chunk, index) => {
    values[`${baseKey}:chunk:${index}`] = chunk;
  });
  properties.setProperties(values);

  for (let index = chunks.length; index < previousChunkCount; index += 1) {
    properties.deleteProperty(`${baseKey}:chunk:${index}`);
  }
}

function clearScriptJsonStore_(baseKey) {
  if (!baseKey) return;
  const properties = PropertiesService.getScriptProperties();
  const previousChunkCount = Number(properties.getProperty(`${baseKey}:chunkCount`) || 0);
  for (let index = 0; index < previousChunkCount; index += 1) {
    properties.deleteProperty(`${baseKey}:chunk:${index}`);
  }
  properties.deleteProperty(`${baseKey}:chunkCount`);
}

function compareDispatchRecords_(a, b) {
  const dateCompare = String(b.startDate || b.workDate || '').localeCompare(String(a.startDate || a.workDate || ''));
  if (dateCompare !== 0) return dateCompare;
  const endDateCompare = String(b.endDate || b.workDate || '').localeCompare(String(a.endDate || a.workDate || ''));
  if (endDateCompare !== 0) return endDateCompare;
  const stationCompare = String(a.stationName || a.stationCode).localeCompare(String(b.stationName || b.stationCode), 'zh-Hant');
  if (stationCompare !== 0) return stationCompare;
  const timeCompare = String(a.startTime || '').localeCompare(String(b.startTime || ''));
  if (timeCompare !== 0) return timeCompare;
  return String(a.nurseName || a.nurseEmail).localeCompare(String(b.nurseName || b.nurseEmail), 'zh-Hant');
}

function findHeaderIndex_(headers, aliases, fallbackIndex) {
  const normalizedHeaders = headers.map((header) => String(header || '').trim().toLowerCase());
  for (let i = 0; i < aliases.length; i += 1) {
    const index = normalizedHeaders.indexOf(String(aliases[i] || '').trim().toLowerCase());
    if (index >= 0) return index;
  }
  return typeof fallbackIndex === 'number' ? fallbackIndex : -1;
}

function buildAssignmentKey_(email, orgCode) {
  return `${normalizeEmail_(email)}::${normalizeOrgCode_(orgCode)}`;
}

function normalizeEmail_(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeOrgCode_(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeAssignmentKeys_(values) {
  const rawValues = Array.isArray(values) ? values : [values];
  return Array.from(new Set(rawValues
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function isStationCode_(value) {
  const normalized = normalizeOrgCode_(value);
  if (!normalized) return false;
  return normalized.startsWith(APP_CONFIG.stationCodePrefix);
}

function isExternalStation_(station) {
  return Boolean(station && (
    station.isExternal
    || isExternalStationCodeOrType_(station.code, station.type)
  ));
}

function isExternalStationCodeOrType_(code, type) {
  const normalizedCode = normalizeOrgCode_(code);
  const normalizedType = String(type || '').trim();
  return normalizedCode.startsWith(APP_CONFIG.externalStationCodePrefix)
    || normalizedType.indexOf('委外') >= 0;
}

function escapeRegExp_(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDate_(value, label) {
  const raw = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label}格式錯誤。`);
  }
  const parsed = new Date(`${raw}T00:00:00+08:00`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label}格式錯誤。`);
  }
  return raw;
}

function normalizeYear_(value) {
  const year = Number(value || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error('統計年度格式錯誤。');
  }
  return year;
}

function normalizeTime_(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) {
    throw new Error('時間格式錯誤。');
  }
  return raw;
}

function normalizeHours_(value, startTime, endTime) {
  const raw = String(value === null || typeof value === 'undefined' ? '' : value).trim();
  let hours = raw ? Number(raw) : 0;
  const grossHours = startTime && endTime ? calculateGrossHoursFromTime_(startTime, endTime) : 0;
  const workHours = applyBreakDeduction_(grossHours);

  if (!hours && startTime && endTime) {
    hours = workHours;
  } else if (hours && grossHours && Math.abs(hours - grossHours) < 0.01) {
    hours = workHours;
  }

  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error('工作時數必須大於 0。');
  }
  if (hours > APP_CONFIG.maxHoursPerRecord) {
    throw new Error(`單筆工作時數不可超過 ${APP_CONFIG.maxHoursPerRecord} 小時。`);
  }

  return Math.round(hours * 100) / 100;
}

function calculateHoursFromTime_(startTime, endTime) {
  return applyBreakDeduction_(calculateGrossHoursFromTime_(startTime, endTime));
}

function calculateGrossHoursFromTime_(startTime, endTime) {
  const start = timeToMinutes_(startTime);
  let end = timeToMinutes_(endTime);
  if (end <= start) end += 24 * 60;
  return Math.round(((end - start) / 60) * 100) / 100;
}

function normalizeStoredHours_(value, startTime, endTime) {
  const hours = Number(value || 0);
  const grossHours = startTime && endTime ? calculateGrossHoursFromTime_(startTime, endTime) : 0;
  const workHours = applyBreakDeduction_(grossHours);
  if (Number.isFinite(hours) && hours > 0) {
    if (grossHours && Math.abs(hours - grossHours) < 0.01) return workHours;
    return Math.round(hours * 100) / 100;
  }
  return workHours;
}

function applyBreakDeduction_(hours) {
  const normalized = Number(hours || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) return 0;
  const adjusted = normalized > APP_CONFIG.fullShiftBreakThresholdHours
    ? normalized - APP_CONFIG.fullShiftBreakHours
    : normalized;
  return Math.round(Math.max(0, adjusted) * 100) / 100;
}

function countDateRangeDays_(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+08:00`);
  const end = new Date(`${endDate || startDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 1;
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86400000) + 1);
}

function calculateDispatchTotalHours_(hours, days) {
  const normalizedHours = Number(hours || 0);
  const normalizedDays = Number(days || 0);
  if (!Number.isFinite(normalizedHours) || !Number.isFinite(normalizedDays)) return 0;
  return Math.round(normalizedHours * normalizedDays * 100) / 100;
}

function getDispatchDays_(record) {
  return Number(record && record.dispatchDays || countDateRangeDays_(record.startDate, record.endDate));
}

function getDispatchTotalHours_(record) {
  return Number(record && record.dispatchTotalHours || calculateDispatchTotalHours_(Number(record && record.hours || 0), getDispatchDays_(record)));
}

function timeToMinutes_(value) {
  const parts = String(value || '').split(':').map(Number);
  return parts[0] * 60 + parts[1];
}

function normalizeShortText_(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label}不可超過 ${maxLength} 個字。`);
  }
  return normalized;
}

function getTodayDateString_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
}

function addDays_(dateString, days) {
  const date = new Date(`${dateString}T00:00:00+08:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
}

function formatTimestamp_(value) {
  const date = value instanceof Date ? value : new Date(value || new Date());
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
}

function formatNumber_(value) {
  const numberValue = Number(value || 0);
  if (!Number.isFinite(numberValue)) return '0';
  return String(Math.round(numberValue * 100) / 100);
}

function formatDispatchDateRange_(startDate, endDate) {
  const start = String(startDate || '').trim();
  const end = String(endDate || start).trim();
  if (!start || start === end) return start;
  return `${start}~${end}`;
}
