/**
 * Valid shop access: actual owner OR shop_users staff row (not a bogus owner on someone else's shop).
 */

function shopVisibleToProfileSql(profileParam = '$1', shopAlias = 's') {
  return `(
    ${shopAlias}.owner_id = ${profileParam}::uuid
    OR EXISTS (
      SELECT 1 FROM public.shop_users su
       WHERE su.shop_id = ${shopAlias}.id
         AND su.user_id = ${profileParam}::uuid
         AND (
           lower(su.role::text) <> 'owner'
           OR su.user_id = ${shopAlias}.owner_id
         )
    )
  )`;
}

function shopVisibleToProfilesSql(profilesParam = '$1', shopAlias = 's') {
  return `(
    ${shopAlias}.owner_id = ANY(${profilesParam}::uuid[])
    OR EXISTS (
      SELECT 1 FROM public.shop_users su
       WHERE su.shop_id = ${shopAlias}.id
         AND su.user_id = ANY(${profilesParam}::uuid[])
         AND (
           lower(su.role::text) <> 'owner'
           OR su.user_id = ${shopAlias}.owner_id
         )
    )
  )`;
}

async function pruneFalseOwnerShopLinks(db) {
  if (!db?.query) return { deleted: 0 };
  const result = await db.query(
    `DELETE FROM public.shop_users su
      USING public.shops s
     WHERE su.shop_id = s.id
       AND su.user_id IS DISTINCT FROM s.owner_id
       AND lower(su.role::text) = 'owner'
     RETURNING su.shop_id::text AS shop_id, su.user_id::text AS user_id`
  );
  return { deleted: result.rowCount || 0 };
}

module.exports = {
  shopVisibleToProfileSql,
  shopVisibleToProfilesSql,
  pruneFalseOwnerShopLinks,
};
