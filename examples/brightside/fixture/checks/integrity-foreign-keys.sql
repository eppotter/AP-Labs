-- Every foreign key resolves. One row per child row whose parent is missing.
-- The schema declares these keys too; this check also covers a copy loaded
-- without constraints (for example a warehouse that does not enforce them).
SELECT 'crews.zone_id' AS fk, c.crew_id AS child_id FROM crews c LEFT JOIN zones z ON z.zone_id = c.zone_id WHERE z.zone_id IS NULL
UNION ALL
SELECT 'crew_memberships.crew_id', m.membership_id FROM crew_memberships m LEFT JOIN crews c ON c.crew_id = m.crew_id WHERE c.crew_id IS NULL
UNION ALL
SELECT 'clients.zone_id', c.client_id FROM clients c LEFT JOIN zones z ON z.zone_id = c.zone_id WHERE z.zone_id IS NULL
UNION ALL
SELECT 'properties.client_id', p.property_id FROM properties p LEFT JOIN clients c ON c.client_id = p.client_id WHERE c.client_id IS NULL
UNION ALL
SELECT 'plans.property_id', pl.plan_id FROM plans pl LEFT JOIN properties p ON p.property_id = pl.property_id WHERE p.property_id IS NULL
UNION ALL
SELECT 'plans.package_id', pl.plan_id FROM plans pl LEFT JOIN packages k ON k.package_id = pl.package_id WHERE k.package_id IS NULL
UNION ALL
SELECT 'plan_price_changes.plan_id', ch.change_id FROM plan_price_changes ch LEFT JOIN plans pl ON pl.plan_id = ch.plan_id WHERE pl.plan_id IS NULL
UNION ALL
SELECT 'visits.property_id', v.visit_id FROM visits v LEFT JOIN properties p ON p.property_id = v.property_id WHERE p.property_id IS NULL
UNION ALL
SELECT 'visits.plan_id', v.visit_id FROM visits v LEFT JOIN plans pl ON pl.plan_id = v.plan_id WHERE v.plan_id IS NOT NULL AND pl.plan_id IS NULL
UNION ALL
SELECT 'visits.crew_id', v.visit_id FROM visits v LEFT JOIN crews c ON c.crew_id = v.crew_id WHERE c.crew_id IS NULL
UNION ALL
SELECT 'visits.package_id', v.visit_id FROM visits v LEFT JOIN packages k ON k.package_id = v.package_id WHERE k.package_id IS NULL
UNION ALL
SELECT 'invoices.client_id', i.invoice_id FROM invoices i LEFT JOIN clients c ON c.client_id = i.client_id WHERE c.client_id IS NULL
UNION ALL
SELECT 'invoices.visit_id', i.invoice_id FROM invoices i LEFT JOIN visits v ON v.visit_id = i.visit_id WHERE v.visit_id IS NULL
UNION ALL
SELECT 'invoice_lines.invoice_id', l.line_id FROM invoice_lines l LEFT JOIN invoices i ON i.invoice_id = l.invoice_id WHERE i.invoice_id IS NULL
UNION ALL
SELECT 'invoice_lines.package_id', l.line_id FROM invoice_lines l LEFT JOIN packages k ON k.package_id = l.package_id WHERE l.package_id IS NOT NULL AND k.package_id IS NULL
UNION ALL
SELECT 'invoice_lines.add_on_id', l.line_id FROM invoice_lines l LEFT JOIN add_ons a ON a.add_on_id = l.add_on_id WHERE l.add_on_id IS NOT NULL AND a.add_on_id IS NULL
UNION ALL
SELECT 'payments.invoice_id', y.payment_id FROM payments y LEFT JOIN invoices i ON i.invoice_id = y.invoice_id WHERE i.invoice_id IS NULL
