-- Shops open at as_of.
SELECT COUNT(shop_id) AS n FROM shops
WHERE closed_on IS NULL OR closed_on >= (SELECT CAST(value AS DATE) FROM fixture_meta WHERE key = 'as_of')
