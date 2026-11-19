/**
 * Base model for Quests and per-user quest progress.
 */
const db = require('../config/database');
const logger = require('../utils/logger');

const QuestModel = {
  /**
   * Lists the quest catalog (definitions only, no per-user progress).
   *
   * @returns {Promise<Array<{id: number, questId: string, title: string, target: number}>>}
   */
  async listDefinitions() {
    try {
      return await db('quests')
        .select('id', 'quest_id as questId', 'title', 'target')
        .orderBy('id');
    } catch (error) {
      logger.error('Error in QuestModel.listDefinitions:', error);
      throw error;
    }
  },

  /**
   * Lists every quest with this user's progress against it, defaulting to
   * zero/unclaimed for quests the user hasn't touched yet.
   *
   * @param {number} userId
   * @returns {Promise<Array<{questId: string, target: number, progress: number, claimed: boolean, streak: number}>>}
   */
  async getProgressForUser(userId) {
    try {
      return await db('quests')
        .leftJoin('user_quests', function joinOnUser() {
          this.on('user_quests.quest_id', '=', 'quests.id').andOn(
            'user_quests.user_id',
            '=',
            db.raw('?', [userId])
          );
        })
        .select(
          'quests.quest_id as questId',
          'quests.target as target',
          db.raw('COALESCE(user_quests.progress, 0) as progress'),
          db.raw('COALESCE(user_quests.claimed, false) as claimed'),
          db.raw('COALESCE(user_quests.streak, 0) as streak')
        )
        .orderBy('quests.id');
    } catch (error) {
      logger.error('Error in QuestModel.getProgressForUser:', error);
      throw error;
    }
  },

  /**
   * Adds `delta` to a user's progress on a non-repeating quest (e.g.
   * play-5-games), clamped to the quest's target. Completion (progress >=
   * target) is derived from progress only and is deliberately NOT reward
   * settlement: this method never sets `claimed`, which is reserved for an
   * actual payout/mint performed by a separate settlement flow (#1588).
   * A no-op (returns null) if the quest slug doesn't exist; callers are
   * expected to fire-and-forget this, never let a missing quest definition
   * break the action that triggered it.
   *
   * @param {number} userId
   * @param {string} questSlug
   * @param {number} [delta=1]
   * @returns {Promise<object|null>}
   */
  async recordProgress(userId, questSlug, delta = 1) {
    try {
      const quest = await db('quests').where({ quest_id: questSlug }).first();
      if (!quest) return null;

      const existing = await db('user_quests')
        .where({ user_id: userId, quest_id: quest.id })
        .first();

      if (!existing) {
        const progress = Math.min(delta, quest.target);
        const completed = progress >= quest.target;
        const rows = await db('user_quests')
          .insert({
            user_id: userId,
            quest_id: quest.id,
            progress,
            // `claimed` means the reward was actually settled, not merely
            // earned. Reaching the target seeds the streak but must not imply
            // a payout (#1588).
            claimed: false,
            streak: completed ? 1 : 0,
            updated_at: db.fn.now(),
          })
          .returning('*');
        return rows[0];
      }

      const progress = Math.min(existing.progress + delta, quest.target);
      // First completion is a progress transition, not a settlement event.
      // Bumping the streak on that transition (rather than on `claimed`)
      // keeps it at exactly once while leaving `claimed` for the real payout
      // flow (#1588).
      const justCompleted = Number(existing.progress) < quest.target && progress >= quest.target;
      const rows = await db('user_quests')
        .where({ id: existing.id })
        .update({
          progress,
          claimed: existing.claimed,
          streak: justCompleted ? existing.streak + 1 : existing.streak,
          updated_at: db.fn.now(),
        })
        .returning('*');
      return rows[0];
    } catch (error) {
      logger.error('Error in QuestModel.recordProgress:', error);
      throw error;
    }
  },

  /**
   * Records a daily check-in for the daily-login quest. Calendar-day aware:
   * a second check-in the same day is a no-op, a check-in on the very next
   * calendar day extends the streak, and any bigger gap resets it to 1.
   * Checking in completes the daily objective, but never settles its reward:
   * `claimed` is left untouched for the real payout flow (#1588).
   *
   * @param {number} userId
   * @returns {Promise<object|null>}
   */
  async recordDailyLogin(userId) {
    try {
      const quest = await db('quests').where({ quest_id: 'daily-login' }).first();
      if (!quest) return null;

      const existing = await db('user_quests')
        .where({ user_id: userId, quest_id: quest.id })
        .first();
      const today = new Date().toISOString().slice(0, 10);

      if (!existing) {
        const rows = await db('user_quests')
          .insert({
            user_id: userId,
            quest_id: quest.id,
            progress: Math.min(1, quest.target),
            // Daily completion is not settlement; see #1588.
            claimed: false,
            streak: 1,
            updated_at: db.fn.now(),
          })
          .returning('*');
        return rows[0];
      }

      const lastDay = new Date(existing.updated_at).toISOString().slice(0, 10);
      if (lastDay === today) {
        return existing;
      }

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const streak = lastDay === yesterday ? existing.streak + 1 : 1;

      const rows = await db('user_quests')
        .where({ id: existing.id })
        .update({
          progress: Math.min(1, quest.target),
          // Preserve whatever the settlement flow set; a check-in must not
          // flip an earned quest into a paid-out one (#1588).
          claimed: existing.claimed,
          streak,
          updated_at: db.fn.now(),
        })
        .returning('*');
      return rows[0];
    } catch (error) {
      logger.error('Error in QuestModel.recordDailyLogin:', error);
      throw error;
    }
  },
};

module.exports = QuestModel;
