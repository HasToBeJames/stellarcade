const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

jest.mock('../../src/config/database', () => {
  const mock = jest.fn();
  mock.raw = jest.fn().mockResolvedValue({});
  return mock;
});

jest.mock('../../src/config/redis', () => {
  const mockClient = {
    get: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue('OK'),
    ttl: jest.fn().mockResolvedValue(60),
    setEx: jest.fn().mockResolvedValue('OK'),
    connect: jest.fn().mockResolvedValue('OK'),
    on: jest.fn(),
    isOpen: true,
  };
  return { client: mockClient, connectPromise: Promise.resolve() };
});

const router = require('../../src/routes/users.routes');
const User = require('../../src/models/User.model');
const Quest = require('../../src/models/Quest.model');

jest.mock('../../src/models/User.model');
jest.mock('../../src/models/Quest.model');

const app = express();
app.use(express.json());
app.use('/users', router);
app.use((err, req, res, _next) => {
  res.status(err.statusCode || 500).json({ error: { message: err.message, code: err.code } });
});

const JWT_SECRET = 'test-jwt-secret';
const savedJwtSecret = process.env.JWT_SECRET;

/** Mirrors auth.service.js: the token is the only trusted wallet identity. */
const authHeader = (wallet = 'GALICE') =>
  `Bearer ${jwt.sign({ id: 1, walletAddress: wallet, address: wallet }, JWT_SECRET, {
    algorithm: 'HS256',
  })}`;

beforeAll(() => {
  process.env.JWT_SECRET = JWT_SECRET;
});

afterAll(() => {
  if (savedJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = savedJwtSecret;
});

const DB_USER = {
  id: 1,
  wallet_address: 'GALICE',
  username: 'alice',
  telegram_user_id: null,
  telegram_handle: null,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
};

describe('GET /users/profile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('400s when the address query parameter is missing — no auth required', async () => {
    const res = await request(app).get('/users/profile');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_QUERY_PARAM');
    expect(User.findByWallet).not.toHaveBeenCalled();
  });

  test('404s for a wallet with no profile — the normal "needs onboarding" signal', async () => {
    User.findByWallet.mockResolvedValue(null);

    const res = await request(app).get('/users/profile').query({ address: 'GUNKNOWN' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
  });

  test('returns the profile shaped for the frontend\'s UserProfile type, address field included', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);

    const res = await request(app).get('/users/profile').query({ address: 'GALICE' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      address: 'GALICE',
      username: 'alice',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(User.findByWallet).toHaveBeenCalledWith('GALICE');
    expect(Quest.recordDailyLogin).not.toHaveBeenCalled();
  });

  test('does not record a daily login when an anonymous caller reads a profile', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);

    const res = await request(app).get('/users/profile').query({ address: 'GALICE' });

    expect(res.status).toBe(200);
    expect(Quest.recordDailyLogin).not.toHaveBeenCalled();
  });
});

describe('POST /users/create', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('400s when walletAddress is missing', async () => {
    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('creates a new profile and returns it in UserProfile shape', async () => {
    User.findByWallet.mockResolvedValue(null);
    User.create.mockResolvedValue(DB_USER);

    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', username: 'alice' });

    expect(res.status).toBe(201);
    expect(res.body.address).toBe('GALICE');
    expect(User.create).toHaveBeenCalledWith({
      wallet_address: 'GALICE',
      username: 'alice',
      age_confirmed_at: null,
    });
  });

  test('records the age confirmation on a brand-new profile', async () => {
    User.findByWallet.mockResolvedValue(null);
    User.create.mockResolvedValue({
      ...DB_USER,
      age_confirmed_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', username: 'alice', ageConfirmed: true });

    expect(res.status).toBe(201);
    expect(res.body.ageConfirmedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ age_confirmed_at: expect.any(Date) })
    );
  });

  test('is idempotent — returns the existing profile instead of erroring when one already exists', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);

    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE' });

    expect(res.status).toBe(201);
    expect(res.body.address).toBe('GALICE');
    expect(User.create).not.toHaveBeenCalled();
  });

  test('records the age confirmation on a wallet that already has a profile, instead of dropping it', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);
    User.updateByWallet.mockResolvedValue({
      ...DB_USER,
      age_confirmed_at: new Date('2026-01-02T00:00:00.000Z'),
    });

    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', ageConfirmed: true });

    expect(res.status).toBe(201);
    expect(res.body.ageConfirmedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(User.create).not.toHaveBeenCalled();
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', {
      age_confirmed_at: expect.any(Date),
    });
  });

  test('does not re-confirm (or re-touch updateByWallet) a wallet whose age is already confirmed', async () => {
    User.findByWallet.mockResolvedValue({
      ...DB_USER,
      age_confirmed_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', ageConfirmed: true });

    expect(res.status).toBe(201);
    expect(User.updateByWallet).not.toHaveBeenCalled();
  });
});

describe('POST /users/update', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('400s when walletAddress is missing', async () => {
    const res = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader())
      .send({ username: 'alice' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
  });

  test('404s when the wallet has no existing profile to update', async () => {
    User.findByWallet.mockResolvedValue(null);

    const res = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader('GUNKNOWN'))
      .send({ walletAddress: 'GUNKNOWN', username: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
    expect(User.updateByWallet).not.toHaveBeenCalled();
  });

  test('links a Telegram account without touching the username', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);
    User.updateByWallet.mockResolvedValue({
      ...DB_USER,
      telegram_user_id: '944872850',
      telegram_handle: '@user_944872850',
    });

    const res = await request(app).post('/users/update').set('Authorization', authHeader()).send({
      walletAddress: 'GALICE',
      telegramUserId: '944872850',
      telegramHandle: '@user_944872850',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        address: 'GALICE',
        telegramLinked: true,
        telegramUserId: '944872850',
        telegramHandle: '@user_944872850',
      })
    );
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', {
      telegram_user_id: '944872850',
      telegram_handle: '@user_944872850',
    });
  });

  test('renaming does not require or touch Telegram fields', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);
    User.updateByWallet.mockResolvedValue({ ...DB_USER, username: 'alice2' });

    const res = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', username: 'alice2' });

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('alice2');
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', { username: 'alice2' });
  });

  test('records the age confirmation on a profile that predates the age gate', async () => {
    User.findByWallet.mockResolvedValue(DB_USER);
    User.updateByWallet.mockResolvedValue({
      ...DB_USER,
      age_confirmed_at: new Date('2026-01-03T00:00:00.000Z'),
    });

    const res = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', ageConfirmed: true });

    expect(res.status).toBe(200);
    expect(res.body.ageConfirmedAt).toBe('2026-01-03T00:00:00.000Z');
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', {
      age_confirmed_at: expect.any(Date),
    });
  });

  test('never clears an existing age confirmation when ageConfirmed is omitted or false', async () => {
    User.findByWallet.mockResolvedValue({
      ...DB_USER,
      age_confirmed_at: new Date('2026-01-01T00:00:00.000Z'),
    });
    User.updateByWallet.mockResolvedValue({
      ...DB_USER,
      username: 'alice2',
      age_confirmed_at: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader())
      .send({ walletAddress: 'GALICE', username: 'alice2', ageConfirmed: false });

    expect(res.status).toBe(200);
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', { username: 'alice2' });
  });
});

describe('profile write ownership (#1552)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['/users/create', '/users/update'])(
    'rejects an anonymous %s write before any store access',
    async (path) => {
      const res = await request(app).post(path).send({ walletAddress: 'GALICE', username: 'x' });

      expect(res.status).toBe(401);
      expect(User.create).not.toHaveBeenCalled();
      expect(User.updateByWallet).not.toHaveBeenCalled();
    }
  );

  test.each(['/users/create', '/users/update'])(
    'rejects an invalid bearer token on %s',
    async (path) => {
      const res = await request(app)
        .post(path)
        .set('Authorization', 'Bearer not-a-real-token')
        .send({ walletAddress: 'GALICE', username: 'x' });

      expect(res.status).toBe(401);
      expect(User.create).not.toHaveBeenCalled();
      expect(User.updateByWallet).not.toHaveBeenCalled();
    }
  );

  test.each(['/users/create', '/users/update'])(
    'rejects a body naming another wallet than the token proves on %s',
    async (path) => {
      User.findByWallet.mockResolvedValue(DB_USER);

      const res = await request(app)
        .post(path)
        .set('Authorization', authHeader('GALICE'))
        .send({ walletAddress: 'GBOB', username: 'x' });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(User.create).not.toHaveBeenCalled();
      expect(User.updateByWallet).not.toHaveBeenCalled();
      expect(User.findByWallet).not.toHaveBeenCalledWith('GBOB');
    }
  );

  test('rejects a valid token that carries no wallet identity', async () => {
    const token = jwt.sign({ id: 1 }, JWT_SECRET, { algorithm: 'HS256' });

    const res = await request(app)
      .post('/users/update')
      .set('Authorization', `Bearer ${token}`)
      .send({ walletAddress: 'GALICE', username: 'x' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(User.updateByWallet).not.toHaveBeenCalled();
  });

  test('an owner can still create and update their own wallet', async () => {
    User.findByWallet.mockResolvedValue(null);
    User.create.mockResolvedValue(DB_USER);

    const created = await request(app)
      .post('/users/create')
      .set('Authorization', authHeader('GALICE'))
      .send({ walletAddress: 'GALICE', username: 'alice' });
    expect(created.status).toBe(201);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({ wallet_address: 'GALICE' }));

    User.findByWallet.mockResolvedValue(DB_USER);
    User.updateByWallet.mockResolvedValue({ ...DB_USER, username: 'alice2' });
    const updated = await request(app)
      .post('/users/update')
      .set('Authorization', authHeader('GALICE'))
      .send({ address: 'GALICE', username: 'alice2' });
    expect(updated.status).toBe(200);
    expect(User.updateByWallet).toHaveBeenCalledWith('GALICE', { username: 'alice2' });
  });
});
