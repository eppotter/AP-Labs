-- Every postal code is five digits.
-- protected-columns: shops.postal_code
SELECT shop_id FROM shops WHERE NOT regexp_full_match(postal_code, '[0-9]{5}')
