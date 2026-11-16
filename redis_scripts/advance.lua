local current = redis.call('HGET', KEYS[1], 'status')
if not current then
    return -1
end
if current == ARGV[2] then
    return 1
end
if current ~= ARGV[1] then
    return 0
end
redis.call('HSET', KEYS[1], 'status', ARGV[2])
redis.call('PUBLISH', KEYS[2], ARGV[2])
return 1
