const APP_CONFIG = {
  title: '駐站護理師工時調派',
  personnelSheetName: '人員主檔',
  orgSheetName: '組織架構樹',
  assignmentSheetName: '人員職務配置',
  stationCodePrefix: 'GRP-CO-',
  storeKey: 'stationNurseWorkHours:v1',
  chunkSize: 8000,
  maxRecords: 3000,
  defaultRangeDays: 31,
  maxHoursPerRecord: 24,
  fullShiftBreakHours: 1,
  fullShiftBreakThresholdHours: 8,
  unavailableStatusKeywords: ['育嬰', '留停', '留職停薪', '停薪', '留職', '停職', '休職'],
  shiftOptions: ['日班', '上午', '下午', '夜班', '支援', '其他']
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
      shiftOptions: APP_CONFIG.shiftOptions.slice()
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
      message: error && error.message ? error.message : '無法讀取工時調派資料。'
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

    lock.waitLock(10000);
    hasLock = true;

    const source = loadDispatchSource_();
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const normalized = normalizeWorkHourPayload_(payload, context, viewerEmail);
    const records = getStoredDispatchRecords_();
    const existingIndex = normalized.id
      ? records.findIndex((record) => record.id === normalized.id && record.status === '有效')
      : -1;
    assertNoOverlappingNurseDispatch_(normalized, records);
    const previousAssignmentKey = existingIndex >= 0 ? records[existingIndex].assignmentKey : '';
    const now = formatTimestamp_(new Date());

    if (existingIndex >= 0) {
      const existing = records[existingIndex];
      assertCanManageStation_(context, existing.stationCode);
      records.splice(existingIndex, 1, {
        ...existing,
        ...normalized,
        id: existing.id,
        createdAt: existing.createdAt,
        createdBy: existing.createdBy,
        updatedAt: now,
        updatedBy: viewerEmail,
        status: '有效'
      });
    } else {
      records.unshift({
        ...normalized,
        id: Utilities.getUuid(),
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

function deleteWorkHourDispatch(payload) {
  const viewerEmail = normalizeEmail_(getCurrentUserEmail());
  const lock = LockService.getScriptLock();
  let hasLock = false;

  try {
    if (!viewerEmail) {
      throw new Error('無法辨識目前登入帳號。');
    }

    lock.waitLock(10000);
    hasLock = true;

    const id = String(payload && payload.id || '').trim();
    if (!id) {
      throw new Error('缺少調派紀錄 ID。');
    }

    const source = loadDispatchSource_();
    const context = buildDispatchContext_(source, viewerEmail, {
      testMode: Boolean(payload && payload.testMode)
    });
    const records = getStoredDispatchRecords_();
    const targetIndex = records.findIndex((record) => record.id === id && record.status === '有效');
    if (targetIndex < 0) {
      throw new Error('找不到要刪除的調派紀錄。');
    }

    assertCanManageStation_(context, records[targetIndex].stationCode);
    records[targetIndex] = {
      ...records[targetIndex],
      status: '已刪除',
      updatedAt: formatTimestamp_(new Date()),
      updatedBy: viewerEmail
    };

    saveStoredDispatchRecords_(records);
    syncTemporaryDispatchColumn_(source, records, [records[targetIndex].assignmentKey]);
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

function loadDispatchSource_() {
  const spreadsheet = getDispatchSourceSpreadsheet_();
  const personnelSheet = getPersonnelSheet_(spreadsheet);
  const assignmentSheet = getAssignmentSheet_(spreadsheet);
  const orgSheet = getSheetByNameOrNull_(spreadsheet, getEnvString_('DISPATCH_ORG_SHEET_NAME', APP_CONFIG.orgSheetName));
  const personnel = personnelSheet ? readPersonnelRecords_(personnelSheet) : [];
  const personnelByEmail = new Map(personnel.map((person) => [person.email, person]));
  const assignments = readAssignmentRecords_(assignmentSheet, personnelByEmail);
  const orgStations = orgSheet ? readStationRecords_(orgSheet) : [];
  const stations = mergeStationsWithAssignmentGroups_(orgStations, assignments);

  if (stations.length === 0) {
    return {
      assignmentSheet,
      personnelByEmail,
      assignments,
      stations: deriveStationsFromAssignments_(assignments)
    };
  }

  return {
    assignmentSheet,
    personnelByEmail,
    assignments,
    stations
  };
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
      isIsoCertified: String(row[isoIndex] || '').trim().toUpperCase() === 'V'
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
          isIsoCertified: false
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
      isIsoCertified: Boolean(existing.isIsoCertified || assignmentStation.isIsoCertified)
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
  const visibleNurses = stationAssignments
    .filter((assignment) => (
      isNurseAssignment_(assignment)
      && (testMode || visibleStationCodes.has(assignment.orgCode))
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
      testMode
    },
    stations: managedStations
      .sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant'))
      .map((station) => ({
        code: station.code,
        name: station.name || station.code,
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

function assertCanManageStation_(context, stationCode) {
  const normalizedStationCode = normalizeOrgCode_(stationCode);
  const canManage = context.stations.some((station) => station.code === normalizedStationCode);
  if (!canManage) {
    throw new Error('您沒有管理此駐站工時調派的權限。');
  }
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

  const assignmentKey = String(payload.assignmentKey || '').trim();
  const member = (context.nurses || []).find((item) => item.assignmentKey === assignmentKey);
  if (!member) {
    throw new Error('找不到可調派的護理師配置。');
  }
  if (member.isUnavailable) {
    throw new Error(`${member.name || member.email} 目前狀態為「${member.status || '不可調配'}」，不得調派。`);
  }

  const startTime = normalizeTime_(payload.startTime);
  const endTime = normalizeTime_(payload.endTime);
  const hours = normalizeHours_(payload.hours, startTime, endTime);
  const shiftName = normalizeShortText_(payload.shiftName || '日班', '班別', 30);
  const note = normalizeShortText_(payload.note || '', '備註', 300);
  const originalStationCode = normalizeOrgCode_(member.orgCode);
  const originalStationName = String(member.orgName || originalStationCode).trim();
  const isTemporaryDispatch = Boolean(originalStationCode && originalStationCode !== station.code);
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
    '同一位護理師在重疊期間不可同時調派到不同駐站。',
    `既有調派：${formatDispatchDateRange_(conflict.startDate, conflict.endDate)} ${conflict.stationName || conflict.stationCode}`,
    `本次調派：${formatDispatchDateRange_(target.startDate, target.endDate)} ${target.stationName || target.stationCode}`
  ].join('\n'));
}

function dateRangesOverlap_(leftStart, leftEnd, rightStart, rightEnd) {
  const normalizedLeftStart = String(leftStart || '').trim();
  const normalizedLeftEnd = String(leftEnd || leftStart || '').trim();
  const normalizedRightStart = String(rightStart || '').trim();
  const normalizedRightEnd = String(rightEnd || rightStart || '').trim();
  if (!normalizedLeftStart || !normalizedLeftEnd || !normalizedRightStart || !normalizedRightEnd) return false;
  return normalizedLeftStart <= normalizedRightEnd && normalizedLeftEnd >= normalizedRightStart;
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
  keys.forEach((assignmentKey) => {
    const assignment = assignmentsByKey.get(assignmentKey);
    if (!assignment || !assignment.rowIndex) return;

    const value = buildTemporaryDispatchCellValue_(records, assignmentKey);
    sheet.getRange(Number(assignment.rowIndex), temporaryDispatchIndex + 1).setValue(value);
  });
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
  const records = getScriptJsonStore_(APP_CONFIG.storeKey)
    .map(normalizeStoredDispatchRecord_)
    .filter(Boolean);
  return records;
}

function saveStoredDispatchRecords_(records) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeStoredDispatchRecord_)
    .filter(Boolean)
    .sort(compareDispatchRecords_)
    .slice(0, APP_CONFIG.maxRecords);
  setScriptJsonStore_(APP_CONFIG.storeKey, normalized, APP_CONFIG.maxRecords);
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
    shiftName: String(record.shiftName || '日班').trim(),
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

function isStationCode_(value) {
  const normalized = normalizeOrgCode_(value);
  if (!normalized) return false;
  return normalized.startsWith(APP_CONFIG.stationCodePrefix);
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
