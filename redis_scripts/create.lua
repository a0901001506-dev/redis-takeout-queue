-- Allocate the ticket, save the order, and append its number in one operation.
local request_key = KEYS[4]
if request_key then
    local existing = redis.call('GET', request_key)
    if existing then
        if redis.call('HGET', ARGV[1] .. existing, 'item') == ARGV[2] then
            return existing
        end
        return false
    end
end

local sequence = redis.call('INCR', KEYS[1])
local number = string.format('A%03d', sequence)
redis.call('HSET', ARGV[1] .. number,
    'number', number, 'item', ARGV[2], 'status', 'preparing')
redis.call('RPUSH', KEYS[2], number)
if request_key then
    redis.call('SET', request_key, number, 'EX', 86400)
end
redis.call('PUBLISH', KEYS[3], number)
return number
