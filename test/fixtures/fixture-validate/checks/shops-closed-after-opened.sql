-- A shop closes on or after it opens.
SELECT shop_id FROM shops WHERE closed_on < opened_on
