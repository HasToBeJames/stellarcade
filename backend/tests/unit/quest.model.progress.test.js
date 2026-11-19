/**
 * Unit tests for Quest.model's write-side progress tracking.
 */
const mockLogger = { error: jest.fn(), info: jest.fn() };
jest.mock('../../src/utils/logger', () => mockLogger);

function makeDb() {
  const tables = {};

  const db = jest.fn((name) => {
    const builder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn(() => Promise.resolve(tables[name]?.firstResult)),
      insert: jest.fn((row) => {
        const inserted = { id: 1, ...row };
        tables[name].insertResult = inserted;
        return { returning: jest.fn(() => Promise.resolve([inserted])) };
      }),
      update: jest.fn((patch) => {
        const updated = { ...tables[name].firstResult, ...patch };
        return { returning: jest.fn(() => Promise.resolve([updated])) };
      }),
    };
    return builder;
  });
  db.fn = { now: jest.fn(() => 'NOW()') };

  return { db, tables };
}

describe('QuestModel.recordProgress', () => {
  test('returns null when the quest slug does not exist', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: undefined };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'not-a-real-quest', 1);
    expect(result).toBeNull();
  });

  test('creates a fresh progress row, clamped to target, when none exists', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'play-5-games', target: 5 } };
    tables.user_quests = { firstResult: undefined };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'play-5-games', 1);
    expect(result.progress).toBe(1);
    expect(result.claimed).toBe(false);
  });

  test('a fresh row that already reaches target is completed but not settled', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'play-2-games', target: 2 } };
    tables.user_quests = { firstResult: undefined };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'play-2-games', 2);
    expect(result.progress).toBe(2);
    // Completion must not imply a payout. This assertion fails with the
    // pre-#1588 behaviour, which set claimed = progress >= target.
    expect(result.claimed).toBe(false);
    expect(result.streak).toBe(1);
  });

  test('marks completion via streak without settling claimed at target', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'win-3-games', target: 3 } };
    tables.user_quests = {
      firstResult: { id: 5, progress: 2, claimed: false, streak: 0 },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'win-3-games', 1);
    expect(result.progress).toBe(3);
    // Completion is progress-based; no payout happened, so the reward is not
    // settled. This fails with the old claimed-on-completion behaviour.
    expect(result.claimed).toBe(false);
    expect(result.streak).toBe(1);
  });

  test('a completed quest stays unclaimed and bumps streak only once', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'play-5-games', target: 5 } };
    tables.user_quests = {
      firstResult: { id: 5, progress: 5, claimed: false, streak: 1 },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'play-5-games', 1);
    expect(result.progress).toBe(5);
    expect(result.claimed).toBe(false);
    // With claimed no longer tracking completion, the streak bump must be
    // driven by the progress transition, not by a one-time claimed flip.
    expect(result.streak).toBe(1);
  });

  test('a genuinely settled reward is preserved by later progress', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'play-5-games', target: 5 } };
    tables.user_quests = {
      firstResult: { id: 5, progress: 2, claimed: true, streak: 1 },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'play-5-games', 1);
    expect(result.progress).toBe(3);
    expect(result.claimed).toBe(true);
  });

  test('does not exceed the target even if progress is added past it', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 2, quest_id: 'play-5-games', target: 5 } };
    tables.user_quests = {
      firstResult: { id: 5, progress: 5, claimed: true, streak: 1 },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordProgress(1, 'play-5-games', 1);
    expect(result.progress).toBe(5);
    // already claimed before this call — must not double-increment the streak
    expect(result.streak).toBe(1);
  });
});

describe('QuestModel.recordDailyLogin', () => {
  test('creates a streak-1 row on the very first check-in', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    tables.quests = { firstResult: { id: 3, quest_id: 'daily-login', target: 1 } };
    tables.user_quests = { firstResult: undefined };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordDailyLogin(7);
    expect(result.progress).toBe(1);
    // Checking in completes the daily objective but never settles its reward.
    // This fails with the old claimed: quest.target <= 1 behaviour.
    expect(result.claimed).toBe(false);
    expect(result.streak).toBe(1);
  });

  test('a second check-in the same day is a no-op, not a double-count', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    const today = new Date().toISOString();
    tables.quests = { firstResult: { id: 3, quest_id: 'daily-login', target: 1 } };
    tables.user_quests = {
      firstResult: { id: 9, progress: 1, claimed: true, streak: 4, updated_at: today },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordDailyLogin(7);
    expect(result.streak).toBe(4);
  });

  test('checking in on the very next calendar day extends the streak', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    tables.quests = { firstResult: { id: 3, quest_id: 'daily-login', target: 1 } };
    tables.user_quests = {
      firstResult: { id: 9, progress: 1, claimed: true, streak: 4, updated_at: yesterday },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordDailyLogin(7);
    expect(result.streak).toBe(5);
    // A real settlement is preserved across check-ins.
    expect(result.claimed).toBe(true);
  });

  test('a new-day check-in never settles an unclaimed daily reward', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    tables.quests = { firstResult: { id: 3, quest_id: 'daily-login', target: 1 } };
    tables.user_quests = {
      firstResult: { id: 9, progress: 1, claimed: false, streak: 4, updated_at: yesterday },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordDailyLogin(7);
    expect(result.streak).toBe(5);
    // Fails with the old `claimed: true` update on every new-day check-in.
    expect(result.claimed).toBe(false);
  });

  test('a gap of more than a day resets the streak to 1, not zero', async () => {
    jest.resetModules();
    const { db, tables } = makeDb();
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    tables.quests = { firstResult: { id: 3, quest_id: 'daily-login', target: 1 } };
    tables.user_quests = {
      firstResult: { id: 9, progress: 1, claimed: true, streak: 4, updated_at: lastWeek },
    };
    jest.doMock('../../src/config/database', () => db);
    const QuestModel = require('../../src/models/Quest.model');

    const result = await QuestModel.recordDailyLogin(7);
    expect(result.streak).toBe(1);
  });
});
