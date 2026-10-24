-- Every shop's region exists.
SELECT s.shop_id FROM shops s LEFT JOIN regions r ON r.region_id = s.region_id WHERE r.region_id IS NULL
