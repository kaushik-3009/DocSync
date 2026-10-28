import Redis from "ioredis";
import RedisMock from "ioredis-mock";

/** Real Redis when TEST_REDIS_URL is set, otherwise an in-process mock.
 *  Mock instances share pub/sub state, so both behave like separate
 *  connections to one server. */
export function createTestRedis(): Redis {
  const url = process.env.TEST_REDIS_URL;
  return (url ? new Redis(url) : new RedisMock()) as unknown as Redis;
}
