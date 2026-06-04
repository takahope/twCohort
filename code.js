const APP_CONFIG = {
  title: '駐站護理師工時調派',
  personnelSheetName: '人員主檔',
  orgSheetName: '組織架構樹',
  assignmentSheetName: '人員職務配置',
  stationCodePrefix: 'GRP-CO-',
  externalStationCodePrefix: 'GRP-CO-EX-',
  stationManagerTitle: '駐站管理員',
  storeKey: 'stationNurseWorkHours:v1',
  sourceCacheKey: 'stationNurseDispatchSource:v1',
  recordsCacheKey: 'stationNurseWorkHours:records:v1',
  cacheMaxChars: 90000,
  sourceCacheSeconds: 120,
  recordsCacheSeconds: 45,
  writeLockWaitMs: 30000,
  chunkSize: 8000,
  maxRecords: 3000,
  defaultRangeDays: 31,
  temporaryDispatchCooldownDays: 30,
  maxHoursPerRecord: 24,
  maxImportRows: 300,
  fullShiftBreakHours: 1,
  fullShiftBreakThresholdHours: 8,
  unavailableStatusKeywords: ['育嬰', '留停', '留職停薪', '停薪', '留職', '停職', '休職'],
  shiftOptions: ['正常班', '行動收案']
};

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

const DISPATCH_IMPORT_FIELD_ALIASES = {
  dateRange: ['期間', '日期區間', '調派期間', '調派日期', 'dateRange'],
  startDate: ['調派起日', '起日', '開始日期', '日期', 'workDate', 'startDate'],
  endDate: ['調派迄日', '迄日', '結束日期', 'endDate'],
  station: ['調派駐站', '目標駐站', '駐站', '至', '至駐站', 'station', 'stationName'],
  stationCode: ['調派駐站代碼', '目標駐站代碼', '駐站代碼', 'stationCode'],
  sourceStation: ['來源駐站', '原駐站', '原', 'from', 'originalStation', 'originalStationName'],
  sourceStationCode: ['來源駐站代碼', '原駐站代碼', 'originalStationCode'],
  assignmentKey: ['護理師配置鍵', 'assignmentKey'],
  nurseName: ['護理師', '人員', '姓名', '護理師姓名', 'nurseName'],
  nurseEmail: ['護理師信箱', '信箱', '電子信箱', '電子郵件', 'nurseEmail', 'email'],
  shiftName: ['班別', '模式', 'shiftName'],
  hours: ['時數', '工時', 'hours'],
  note: ['備註', 'note'],
  temporaryInfo: ['臨時調配', '臨調', 'temporaryDispatch']
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

function getDispatchAppData(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    const filters = normalizeDispatchFilters_(payload);
    const source = loadDispatchSource_();
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const allowedStationCodes = new Set(context.stations.map((station) => station.code));
    const assignmentAvailabilityByKey = buildAssignmentAvailabilityByKey_(source.assignments);
    const records = loadDispatchRecords_(allowedStationCodes, filters, {
      assignmentAvailabilityByKey
    });
    const scheduleRecords = loadDispatchRecords_(allowedStationCodes, {
      ...filters,
      stationCode: '',
      nurseEmail: ''
    }, {
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
      includeOriginalStation: true,
      assignmentAvailabilityByKey
    });

    return {
      success: true,
      viewer: context.viewer,
      stations: context.stations,
      nurses: context.nurses,
      records,
      scheduleRecords,
      currentRecords,
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
      includeOriginalStation: true,
      assignmentAvailabilityByKey
    })
      .filter((record) => isTemporaryDispatchRecord_(record))
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
      records
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
    const records = getStoredDispatchRecords_();
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

    if (existingIndex >= 0) {
      const existing = records[existingIndex];
      assertCanManageStation_(context, existing.stationCode);
      assertDispatchRecordVersion_(existing, payload, '儲存', source);
      records.splice(existingIndex, 1, {
        ...existing,
        ...normalized,
        id: existing.id,
        createdAt: existing.createdAt,
        createdBy: existing.createdBy,
        version: createDispatchRecordVersion_(),
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      });
    } else {
      records.unshift({
        ...normalized,
        id: Utilities.getUuid(),
        version: createDispatchRecordVersion_(),
        createdAt: now,
        createdBy: viewerEmail,
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      });
    }

    saveStoredDispatchRecords_(records);
    syncTemporaryDispatchColumn_(source, records, [
      normalized.assignmentKey,
      previousAssignmentKey
    ]);
    lock.releaseLock();
    hasLock = false;
    return getDispatchAppData(payload && payload.filters ? payload.filters : {});
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
    const records = getStoredDispatchRecords_();
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
    saveStoredDispatchRecords_(records);
    syncTemporaryDispatchColumn_(source, records, normalizedRecords.map((record) => record.assignmentKey));
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(payload && payload.filters ? payload.filters : {});
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
    const records = getStoredDispatchRecords_();
    const targetIndex = records.findIndex((record) => record.id === id && record.status === '有效');
    if (targetIndex < 0) {
      const inactiveRecord = records.find((record) => record.id === id);
      if (inactiveRecord) {
        throw new Error(buildDispatchDeletedConflictMessage_(inactiveRecord, '刪除', source));
      }
      throw new Error('找不到要刪除的調派紀錄。請先按「重新整理」查看最新調派內容。');
    }

    assertCanManageStation_(context, records[targetIndex].stationCode);
    assertDispatchRecordVersion_(records[targetIndex], payload, '刪除', source);
    records[targetIndex] = {
      ...records[targetIndex],
      status: '已刪除',
      version: createDispatchRecordVersion_(),
      updatedAt: formatTimestamp_(new Date()),
      updatedBy: viewerEmail
    };

    saveStoredDispatchRecords_(records);
    syncTemporaryDispatchColumn_(source, records, [records[targetIndex].assignmentKey]);
    lock.releaseLock();
    hasLock = false;
    return getDispatchAppData(payload && payload.filters ? payload.filters : {});
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

function previewWorkHourDispatchImport(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    const source = loadDispatchSource_({ forceFresh: true });
    const context = buildDispatchContext_(source, viewerEmail, { testMode: false });
    assertCanImportDispatchRecords_(context);
    const records = getStoredDispatchRecords_();
    const plan = buildWorkHourDispatchImportPlan_(payload, source, context, records, viewerEmail);
    return {
      success: true,
      ...serializeWorkHourDispatchImportPlan_(plan)
    };
  } catch (error) {
    console.error('預覽正式調派匯入失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法預覽正式調派匯入。'
    };
  }
}

function commitWorkHourDispatchImport(payload) {
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
    const context = buildDispatchContext_(source, viewerEmail, { testMode: false });
    assertCanImportDispatchRecords_(context);
    const records = getStoredDispatchRecords_();
    const plan = buildWorkHourDispatchImportPlan_(payload, source, context, records, viewerEmail);
    if (plan.summary.errorCount > 0) {
      throw new Error(`匯入資料仍有 ${plan.summary.errorCount} 筆錯誤，請先修正後重新預覽。`);
    }
    if (!plan.pendingRecords.length) {
      throw new Error('沒有可正式匯入的新調派紀錄。');
    }

    const now = formatTimestamp_(new Date());
    const importedRecords = plan.pendingRecords.map((record) => ({
      ...record,
      id: Utilities.getUuid(),
      version: createDispatchRecordVersion_(),
      createdAt: now,
      createdBy: viewerEmail,
      updatedAt: now,
      updatedBy: viewerEmail,
      status: '有效'
    }));
    records.unshift(...importedRecords);
    saveStoredDispatchRecords_(records);
    syncTemporaryDispatchColumn_(source, records, importedRecords.map((record) => record.assignmentKey));
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData({
      ...(payload && payload.filters ? payload.filters : {}),
      testMode: false
    });
    response.importSummary = {
      ...plan.summary,
      createdCount: importedRecords.length
    };
    return response;
  } catch (error) {
    console.error('正式匯入調派資料失敗:', error);
    return {
      success: false,
      message: error && error.message ? error.message : '無法正式匯入調派資料。'
    };
  } finally {
    if (hasLock) lock.releaseLock();
  }
}

function buildWorkHourDispatchImportPlan_(payload, source, context, existingRecords, viewerEmail) {
  const importPayload = normalizeDispatchImportPayload_(payload);
  const parsed = parseDispatchImportText_(importPayload.text);
  const results = [];
  const pendingRecords = [];

  parsed.rows.forEach((rawRow) => {
    try {
      const normalized = normalizeDispatchImportRow_(rawRow, parsed.columnMap, importPayload, source, context, viewerEmail);
      const validationRecord = {
        ...normalized,
        id: `IMPORT-${rawRow.rowNumber}`,
        version: 'IMPORT',
        status: '有效'
      };
      const duplicate = findExactDuplicateDispatch_(validationRecord, existingRecords.concat(pendingRecords));
      if (duplicate) {
        results.push(buildDispatchImportRowResult_('skip', rawRow.rowNumber, normalized, [
          duplicate.id && String(duplicate.id).indexOf('IMPORT-') === 0
            ? '與本次匯入其他列重複，正式匯入時會略過。'
            : '系統已有相同調派紀錄，正式匯入時會略過。'
        ]));
        return;
      }

      assertNoOverlappingNurseDispatch_(validationRecord, existingRecords.concat(pendingRecords));
      const warnings = [];
      try {
        assertTemporaryDispatchCooldown_(validationRecord, existingRecords.concat(pendingRecords));
      } catch (error) {
        if (!importPayload.historicalMode) throw error;
        warnings.push(error && error.message ? error.message : '臨時調派間隔未滿 30 天。');
      }

      pendingRecords.push(validationRecord);
      results.push(buildDispatchImportRowResult_('ready', rawRow.rowNumber, normalized, warnings));
    } catch (error) {
      results.push({
        rowNumber: rawRow.rowNumber,
        status: 'error',
        message: error && error.message ? error.message : '此列資料無法匯入。',
        warnings: [],
        startDate: '',
        endDate: '',
        stationName: '',
        originalStationName: '',
        nurseName: '',
        nurseEmail: '',
        shiftName: '',
        dispatchDays: 0
      });
    }
  });

  return {
    rows: results,
    pendingRecords,
    summary: summarizeDispatchImportRows_(results)
  };
}

function normalizeDispatchImportPayload_(payload) {
  const text = String(payload && payload.text || '').trim();
  if (!text) {
    throw new Error('請貼上要匯入的 Excel 或 Google Sheet 表格資料。');
  }
  const year = normalizeYear_(payload && payload.year);
  return {
    text,
    year,
    historicalMode: !(payload && payload.historicalMode === false)
  };
}

function parseDispatchImportText_(text) {
  const lines = String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error('匯入資料至少需要標題列與一筆資料。');
  }
  if (lines.length - 1 > APP_CONFIG.maxImportRows) {
    throw new Error(`單次最多匯入 ${APP_CONFIG.maxImportRows} 筆資料，請分批匯入。`);
  }

  const delimiter = lines[0].indexOf('\t') >= 0 ? '\t' : ',';
  const headers = parseDelimitedLine_(lines[0], delimiter);
  const columnMap = buildDispatchImportColumnMap_(headers);
  validateDispatchImportColumnMap_(columnMap);

  const rows = lines.slice(1).map((line, index) => ({
    rowNumber: index + 2,
    values: parseDelimitedLine_(line, delimiter)
  })).filter((row) => row.values.some((value) => String(value || '').trim()));
  if (!rows.length) {
    throw new Error('匯入資料沒有可處理的內容列。');
  }

  return {
    columnMap,
    rows
  };
}

function parseDelimitedLine_(line, delimiter) {
  if (delimiter === '\t') return String(line || '').split('\t');
  const values = [];
  let value = '';
  let inQuotes = false;
  const raw = String(line || '');
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === '"') {
      if (inQuotes && raw[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return values;
}

function buildDispatchImportColumnMap_(headers) {
  return Object.keys(DISPATCH_IMPORT_FIELD_ALIASES).reduce((map, key) => {
    map[key] = findImportHeaderIndex_(headers, DISPATCH_IMPORT_FIELD_ALIASES[key]);
    return map;
  }, {});
}

function validateDispatchImportColumnMap_(columnMap) {
  const hasDate = columnMap.dateRange >= 0 || columnMap.startDate >= 0;
  const hasStation = columnMap.station >= 0 || columnMap.stationCode >= 0;
  const hasNurse = columnMap.assignmentKey >= 0 || columnMap.nurseEmail >= 0 || columnMap.nurseName >= 0;
  if (!hasDate || !hasStation || !hasNurse) {
    throw new Error('匯入表格缺少必要欄位：期間或調派起日、調派駐站、護理師。');
  }
}

function findImportHeaderIndex_(headers, aliases) {
  const normalizedHeaders = (Array.isArray(headers) ? headers : []).map(normalizeImportLookupText_);
  for (let i = 0; i < aliases.length; i += 1) {
    const index = normalizedHeaders.indexOf(normalizeImportLookupText_(aliases[i]));
    if (index >= 0) return index;
  }
  return -1;
}

function normalizeDispatchImportRow_(row, columnMap, importPayload, source, context, viewerEmail) {
  const dateRange = normalizeDispatchImportDateRange_(
    getDispatchImportCell_(row, columnMap.dateRange),
    getDispatchImportCell_(row, columnMap.startDate),
    getDispatchImportCell_(row, columnMap.endDate),
    importPayload.year
  );
  const targetStation = findDispatchImportStation_(
    source,
    getDispatchImportCell_(row, columnMap.stationCode),
    getDispatchImportCell_(row, columnMap.station),
    '調派駐站'
  );
  assertCanManageStation_(context, targetStation.code);

  const temporaryInfo = getDispatchImportCell_(row, columnMap.temporaryInfo);
  const sourceStationText = getDispatchImportCell_(row, columnMap.sourceStation)
    || extractOriginalStationFromTemporaryInfo_(temporaryInfo);
  const sourceStation = findDispatchImportStation_(
    source,
    getDispatchImportCell_(row, columnMap.sourceStationCode),
    sourceStationText,
    '來源駐站',
    true
  );
  const assignment = findDispatchImportAssignment_(source, {
    assignmentKey: getDispatchImportCell_(row, columnMap.assignmentKey),
    nurseEmail: getDispatchImportCell_(row, columnMap.nurseEmail),
    nurseName: getDispatchImportCell_(row, columnMap.nurseName),
    sourceStationCode: sourceStation && sourceStation.code
  });
  const shiftName = normalizeDispatchMode_(getDispatchImportCell_(row, columnMap.shiftName) || APP_CONFIG.shiftOptions[0]);
  const hours = getDispatchImportCell_(row, columnMap.hours) || 8;

  return normalizeWorkHourPayload_({
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    workDate: dateRange.startDate,
    stationCode: targetStation.code,
    assignmentKey: assignment.assignmentKey,
    shiftName,
    startTime: '',
    endTime: '',
    hours,
    note: getDispatchImportCell_(row, columnMap.note)
  }, context, viewerEmail);
}

function getDispatchImportCell_(row, index) {
  if (!row || index < 0) return '';
  return String(row.values[index] || '').trim();
}

function normalizeDispatchImportDateRange_(rangeText, startText, endText, year) {
  if (startText) {
    const startDate = normalizeDispatchImportDate_(startText, year, '調派起日');
    const endDate = endText
      ? normalizeDispatchImportDate_(endText, year, '調派迄日', Number(startDate.slice(5, 7)))
      : startDate;
    if (endDate < startDate) throw new Error('調派迄日不可早於調派起日。');
    return { startDate, endDate };
  }

  const rawRange = String(rangeText || '').trim();
  if (!rawRange) throw new Error('缺少調派日期。');
  const parts = splitDispatchImportDateRange_(rawRange);
  const startDate = normalizeDispatchImportDate_(parts[0], year, '調派起日');
  const endDate = parts[1]
    ? normalizeDispatchImportDate_(parts[1], year, '調派迄日', Number(startDate.slice(5, 7)))
    : startDate;
  if (endDate < startDate) throw new Error('調派迄日不可早於調派起日。');
  return { startDate, endDate };
}

function splitDispatchImportDateRange_(value) {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  const explicitSeparator = raw.split(/\s*(?:至|到|~|～|－|–|—)\s*/);
  if (explicitSeparator.length >= 2) return [explicitSeparator[0], explicitSeparator.slice(1).join('')];
  const spacedHyphen = raw.split(/\s+-\s+/);
  if (spacedHyphen.length >= 2) return [spacedHyphen[0], spacedHyphen.slice(1).join('')];
  const compactFullSlashRange = raw.match(/^(\d{4}\/\d{1,2}\/\d{1,2})\s*-\s*(\d{4}\/\d{1,2}\/\d{1,2})$/);
  if (compactFullSlashRange) return [compactFullSlashRange[1], compactFullSlashRange[2]];
  const compactMonthRange = raw.match(/^(\d{1,2}\/\d{1,2})\s*-\s*((?:\d{1,2}\/)?\d{1,2})$/);
  if (compactMonthRange) return [compactMonthRange[1], compactMonthRange[2]];
  return [raw, ''];
}

function normalizeDispatchImportDate_(value, year, label, fallbackMonth) {
  const raw = String(value || '')
    .trim()
    .replace(/[年月]/g, '/')
    .replace(/[日號]/g, '')
    .replace(/\./g, '/')
    .replace(/\s+/g, '');
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(raw)) {
    const parts = raw.split(/[-/]/).map(Number);
    return normalizeDateParts_(parts[0], parts[1], parts[2], label);
  }
  if (/^\d{1,2}[-/]\d{1,2}$/.test(raw)) {
    const parts = raw.split(/[-/]/).map(Number);
    return normalizeDateParts_(year, parts[0], parts[1], label);
  }
  if (/^\d{1,2}$/.test(raw) && fallbackMonth) {
    return normalizeDateParts_(year, fallbackMonth, Number(raw), label);
  }
  throw new Error(`${label}格式錯誤，請使用 2026/06/03、6/3 或 6/3-6/5。`);
}

function normalizeDateParts_(year, month, day, label) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`${label}格式錯誤。`);
  }
  const expected = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const date = new Date(`${expected}T00:00:00+08:00`);
  const normalized = Number.isNaN(date.getTime())
    ? ''
    : Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
  if (normalized !== expected) {
    throw new Error(`${label}格式錯誤。`);
  }
  return normalized;
}

function findDispatchImportStation_(source, codeValue, nameValue, label, optional) {
  const stations = Array.isArray(source && source.stations) ? source.stations : [];
  const code = normalizeOrgCode_(codeValue);
  if (code) {
    const station = stations.find((item) => item.code === code);
    if (station) return station;
    throw new Error(`找不到${label}代碼：${code}`);
  }

  const lookup = normalizeImportLookupText_(nameValue);
  if (!lookup) {
    if (optional) return null;
    throw new Error(`缺少${label}。`);
  }
  const baseLookup = normalizeImportLookupText_(String(nameValue || '').replace(/[（(].*?[）)]/g, ''));
  const lookupValues = Array.from(new Set([lookup, baseLookup].filter(Boolean)));

  const matches = stations.filter((station) => (
    lookupValues.includes(normalizeImportLookupText_(station.name))
    || lookupValues.includes(normalizeImportLookupText_(station.alias))
    || lookupValues.includes(normalizeImportLookupText_(station.code))
  ));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    const looseMatches = stations.filter((station) => {
      const names = [station.name, station.alias, station.code]
        .map(normalizeImportLookupText_)
        .filter(Boolean);
      return names.some((name) => lookupValues.some((value) => name.indexOf(value) >= 0 || value.indexOf(name) >= 0));
    });
    if (looseMatches.length === 1) return looseMatches[0];
    if (looseMatches.length > 1) {
      throw new Error(`${label}「${nameValue}」對應到多個駐站，請改填駐站代碼。`);
    }
    throw new Error(`找不到${label}：${nameValue}`);
  }
  throw new Error(`${label}「${nameValue}」對應到多個駐站，請改填駐站代碼。`);
}

function findDispatchImportAssignment_(source, options) {
  const settings = options || {};
  const assignments = (Array.isArray(source && source.assignments) ? source.assignments : [])
    .filter(isNurseAssignment_);
  const assignmentKey = String(settings.assignmentKey || '').trim();
  if (assignmentKey) {
    const assignment = assignments.find((item) => item.assignmentKey === assignmentKey);
    if (assignment) return assignment;
    throw new Error(`找不到護理師配置鍵：${assignmentKey}`);
  }

  const sourceStationCode = normalizeOrgCode_(settings.sourceStationCode);
  const email = normalizeEmail_(settings.nurseEmail);
  const nameLookup = normalizeImportLookupText_(settings.nurseName);
  let matches = assignments;
  if (sourceStationCode) matches = matches.filter((item) => item.orgCode === sourceStationCode);
  if (email) matches = matches.filter((item) => normalizeEmail_(item.email) === email);
  if (!email && nameLookup) matches = matches.filter((item) => normalizeImportLookupText_(item.name) === nameLookup);

  if (!email && !nameLookup) {
    throw new Error('缺少護理師姓名或信箱。');
  }
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new Error(`找不到護理師：${settings.nurseName || settings.nurseEmail}`);
  }
  throw new Error(`護理師「${settings.nurseName || settings.nurseEmail}」對應到多筆配置，請補上護理師信箱或來源駐站。`);
}

function extractOriginalStationFromTemporaryInfo_(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/原\s*[:：]\s*([^\n\r|]+)/);
  return match ? String(match[1] || '').trim() : '';
}

function normalizeImportLookupText_(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[()\[\]{}（）【】［］「」『』]/g, '')
    .replace(/\s+/g, '');
}

function findExactDuplicateDispatch_(target, records) {
  return (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter(Boolean)
    .find((record) => (
      record.status === '有效'
      && record.assignmentKey === target.assignmentKey
      && record.stationCode === target.stationCode
      && record.originalStationCode === target.originalStationCode
      && record.startDate === target.startDate
      && record.endDate === target.endDate
      && record.shiftName === target.shiftName
    ));
}

function buildDispatchImportRowResult_(status, rowNumber, record, messages) {
  const messageList = Array.isArray(messages) ? messages.filter(Boolean) : [];
  return {
    rowNumber,
    status,
    message: status === 'ready' ? '' : messageList.join('\n'),
    warnings: status === 'ready' ? messageList : [],
    startDate: record.startDate,
    endDate: record.endDate,
    stationName: record.stationName,
    originalStationName: record.originalStationName,
    nurseName: record.nurseName,
    nurseEmail: record.nurseEmail,
    shiftName: record.shiftName,
    dispatchDays: getDispatchDays_(record)
  };
}

function summarizeDispatchImportRows_(rows) {
  const summary = {
    totalRows: rows.length,
    readyCount: 0,
    skippedCount: 0,
    errorCount: 0,
    warningCount: 0
  };
  rows.forEach((row) => {
    if (row.status === 'ready') summary.readyCount += 1;
    if (row.status === 'skip') summary.skippedCount += 1;
    if (row.status === 'error') summary.errorCount += 1;
    if (row.warnings && row.warnings.length) summary.warningCount += 1;
  });
  return summary;
}

function serializeWorkHourDispatchImportPlan_(plan) {
  return {
    summary: plan.summary,
    rows: (plan.rows || []).map((row) => ({
      rowNumber: row.rowNumber,
      status: row.status,
      message: row.message,
      warnings: row.warnings || [],
      startDate: row.startDate,
      endDate: row.endDate,
      stationName: row.stationName,
      originalStationName: row.originalStationName,
      nurseName: row.nurseName,
      nurseEmail: row.nurseEmail,
      shiftName: row.shiftName,
      dispatchDays: row.dispatchDays
    }))
  };
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
    const normalized = normalizeCreateStationPayload_(payload, source);
    appendStationRecord_(source.orgSheet, normalized);
    ensureStationManagerAssignment_(source.assignmentSheet, source.assignments, normalized);
    invalidateDispatchSourceCache_();
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(payload && payload.filters ? payload.filters : {});
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
    assertCanManageStation_(context, stationCode);
    assertCanDeleteStation_(source, stationCode);
    deleteStationOrgRows_(source.orgSheet, stationCode);
    deleteStationManagerAssignmentRows_(source.assignmentSheet, stationCode);
    invalidateDispatchSourceCache_();
    lock.releaseLock();
    hasLock = false;

    const response = getDispatchAppData(payload && payload.filters ? payload.filters : {});
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
    throw new Error('尚未設定駐站護理師調派獨立資料 Spreadsheet ID（ENV.DISPATCH_SOURCE_SHEET_ID）。');
  }

  const chrmSpreadsheetId = getEnvString_('CHRM_MASTER_SHEET_ID', getEnvString_('MASTER_SHEET_ID', ''));
  if (chrmSpreadsheetId && spreadsheetId === chrmSpreadsheetId) {
    throw new Error('駐站護理師調派 App 不可讀取 cHRM 正式資料表，請將 ENV.DISPATCH_SOURCE_SHEET_ID 改為獨立試算表 ID。');
  }

  return spreadsheetId;
}

function getEnvString_(key, fallback) {
  if (typeof ENV === 'undefined' || !key || typeof ENV[key] === 'undefined') return fallback;
  const value = String(ENV[key] || '').trim();
  return value || fallback;
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
  cache.put(key, raw, ttlSeconds);
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

function buildDispatchContext_(source, viewerEmail, options) {
  const stationByCode = new Map(source.stations.map((station) => [station.code, { ...station }]));
  const stationAssignments = dedupeAssignments_(source.assignments)
    .filter((assignment) => stationByCode.has(assignment.orgCode));
  const canUseTestMode = canUseTestMode_(viewerEmail, source.assignments);
  const testMode = Boolean(options && options.testMode && canUseTestMode);
  if (options && options.testMode && !canUseTestMode) {
    throw new Error('您沒有測試模式權限。');
  }

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
  const visibleStationCodes = new Set(managedStations.map((station) => station.code));
  const canUseExternalSources = Boolean(testMode || managedStations.length);
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

  const viewerPerson = source.personnelByEmail.get(viewerEmail) || {};
  const viewerAssignment = source.assignments.find((assignment) => assignment.email === viewerEmail) || {};

  return {
    viewer: {
      email: viewerEmail,
      name: String(viewerPerson.name || viewerAssignment.name || '').trim(),
      isStationManager: managedStations.length > 0,
      canUseTestMode,
      canCreateStation: managedStations.length > 0 || canUseTestMode,
      canImportDispatchRecords: managedStationCodes.size > 0,
      testMode
    },
    managedStationCodes,
    stations: managedStations
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
  if (typeof ENV === 'undefined' || !Array.isArray(ENV.TESTER_EMAILS)) return [];
  return ENV.TESTER_EMAILS.map((email) => normalizeEmail_(email)).filter(Boolean);
}

function getTesterTitles_() {
  if (typeof ENV === 'undefined' || !Array.isArray(ENV.TESTER_TITLES)) {
    return ['系統測試人員', '測試人員'];
  }
  return ENV.TESTER_TITLES.map((title) => String(title || '').trim()).filter(Boolean);
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

function assertCanImportDispatchRecords_(context) {
  const canImport = Boolean(context && context.viewer && context.viewer.canImportDispatchRecords);
  if (!canImport) {
    throw new Error('您沒有正式匯入調派資料的權限。請確認登入帳號是駐站管理者。');
  }
}

function assertCanManageStation_(context, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const canManage = context.stations.some((station) => station.code === normalizedStationCode);
  if (!canManage) {
    throw new Error('您沒有管理此駐站工時調派的權限。');
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

function assertCanDeleteStation_(source, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const activeRecords = getStoredDispatchRecords_()
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
    throw new Error('只能調派自己管理範圍內的駐站。');
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

function loadDispatchRecords_(allowedStationCodes, filters, options) {
  return getStoredDispatchRecords_()
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
  const conflict = (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter((record) => (
      record
      && record.status === '有效'
      && record.assignmentKey === target.assignmentKey
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

  const conflict = (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter((record) => (
      record
      && record.status === '有效'
      && record.assignmentKey === target.assignmentKey
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

  (Array.isArray(records) ? records : []).forEach((record) => {
    const days = getDispatchDays_(record);
    const hours = getDispatchTotalHours_(record);
    const targetCode = normalizeOrgCode_(record.stationCode);
    const sourceCode = normalizeOrgCode_(record.originalStationCode);
    if (targetCode) {
      const targetStat = getFairnessStationStat_(stationMap, targetCode, record.stationName || targetCode);
      targetStat.incomingCount += 1;
      targetStat.incomingDays += days;
      targetStat.incomingHours += hours;
      if (record.assignmentKey) targetStat.nurseKeys.add(record.assignmentKey);
    }
    if (sourceCode) {
      const sourceStat = getFairnessStationStat_(stationMap, sourceCode, record.originalStationName || sourceCode);
      sourceStat.outgoingCount += 1;
      sourceStat.outgoingDays += days;
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
      incomingHours: Math.round(stat.incomingHours * 100) / 100,
      outgoingHours: Math.round(stat.outgoingHours * 100) / 100,
      nurseCount: stat.nurseKeys.size
    }))
    .sort((a, b) => {
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
  (Array.isArray(records) ? records : []).forEach((record) => {
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

function syncTemporaryDispatchColumn_(source, records, assignmentKeys) {
  if (typeof ENV !== 'undefined' && ENV.SYNC_TEMPORARY_DISPATCH_COLUMN === false) return;
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

    const value = buildTemporaryDispatchCellValue_(records, assignmentKey);
    sheet.getRange(Number(assignment.rowIndex), temporaryDispatchIndex + 1).setValue(value);
    didWrite = true;
  });
  if (didWrite) invalidateDispatchSourceCache_();
}

function buildTemporaryDispatchCellValue_(records, assignmentKey) {
  const activeTemporaryRecords = (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter((record) => (
      record
      && record.status === '有效'
      && record.assignmentKey === assignmentKey
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
    return [
      '臨調',
      dateText,
      record.nurseName || record.nurseEmail,
      `${formatNumber_(getDispatchDays_(record))}天/${formatNumber_(getDispatchTotalHours_(record))}h`,
      `原:${record.originalStationName || record.originalStationCode}`,
      `至:${record.stationName || record.stationCode}`
    ].filter(Boolean).join(' ');
  });
  return summaryLines.concat(detailLines).join('\n');
}

function getStoredDispatchRecords_() {
  const cachedRecords = getCachedJson_(APP_CONFIG.recordsCacheKey);
  if (Array.isArray(cachedRecords)) {
    return cachedRecords
      .map(normalizeStoredDispatchRecord_)
      .filter(Boolean);
  }

  const records = getScriptJsonStore_(APP_CONFIG.storeKey)
    .map(normalizeStoredDispatchRecord_)
    .filter(Boolean);
  putCachedJson_(APP_CONFIG.recordsCacheKey, records, APP_CONFIG.recordsCacheSeconds);
  return records;
}

function saveStoredDispatchRecords_(records) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter(Boolean)
    .sort(compareDispatchRecords_)
    .slice(0, APP_CONFIG.maxRecords);
  setScriptJsonStore_(APP_CONFIG.storeKey, normalized, APP_CONFIG.maxRecords);
  invalidateDispatchRecordsCache_();
  putCachedJson_(APP_CONFIG.recordsCacheKey, normalized, APP_CONFIG.recordsCacheSeconds);
}

function normalizeStoredDispatchRecord_(record) {
  if (!record || typeof record !== 'object') return null;
  const stationCode = normalizeOrgCode_(record.stationCode);
  const nurseEmail = normalizeEmail_(record.nurseEmail);
  const assignmentKey = String(record.assignmentKey || buildAssignmentKey_(nurseEmail, stationCode)).trim();
  const startDate = String(record.startDate || record.workDate || '').trim();
  const rawEndDate = String(record.endDate || record.workDate || startDate).trim();
  const endDate = rawEndDate < startDate ? startDate : rawEndDate;
  if (!record.id || !startDate || !endDate || !stationCode || !nurseEmail || !assignmentKey) return null;

  const dispatchDays = Number(record.dispatchDays || countDateRangeDays_(startDate, endDate));
  const startTime = String(record.startTime || '').trim();
  const endTime = String(record.endTime || '').trim();
  const hours = normalizeStoredHours_(record.hours, startTime, endTime);

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
    nurseName: String(record.nurseName || nurseEmail).trim(),
    nurseTitle: String(record.nurseTitle || '').trim(),
    originalStationCode: normalizeOrgCode_(record.originalStationCode || stationCode),
    originalStationName: String(record.originalStationName || record.stationName || stationCode).trim(),
    temporaryDispatchLabel: String(record.temporaryDispatchLabel || '').trim(),
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
