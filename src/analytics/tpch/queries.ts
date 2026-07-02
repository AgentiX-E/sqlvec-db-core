/**
 * TPC-H 22 Benchmark Queries
 *
 * Standard TPC-H Query Set (Revision 3.0.1)
 * Adapted for DuckDB compatibility.
 *
 * Each query is a valid SQL string with a .name and .sql property.
 * Query descriptions from the TPC-H specification.
 */

export interface TpchQuery {
  number: number;
  name: string;
  description: string;
  sql: string;
}

export const TPCH_QUERIES: TpchQuery[] = [
  // ─── Q1: Pricing Summary Report ──────────────────────────────────
  {
    number: 1,
    name: 'Pricing Summary Report',
    description: 'Reports the amount of billed, shipped, and returned items.',
    sql: `SELECT
      l_returnflag,
      l_linestatus,
      SUM(l_quantity) AS sum_qty,
      SUM(l_extendedprice) AS sum_base_price,
      SUM(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
      SUM(l_extendedprice * (1 - l_discount) * (1 + l_tax)) AS sum_charge,
      AVG(l_quantity) AS avg_qty,
      AVG(l_extendedprice) AS avg_price,
      AVG(l_discount) AS avg_disc,
      COUNT(*) AS count_order
    FROM
      lineitem
    WHERE
      l_shipdate <= DATE '1998-12-01' - INTERVAL '90' DAY
    GROUP BY
      l_returnflag,
      l_linestatus
    ORDER BY
      l_returnflag,
      l_linestatus`,
  },

  // ─── Q2: Minimum Cost Supplier ───────────────────────────────────
  {
    number: 2,
    name: 'Minimum Cost Supplier',
    description: 'Finds the supplier with the lowest cost for a given part in a given region.',
    sql: `SELECT
      s_acctbal,
      s_name,
      n_name,
      p_partkey,
      p_mfgr,
      s_address,
      s_phone,
      s_comment
    FROM
      part,
      supplier,
      partsupp,
      nation,
      region
    WHERE
      p_partkey = ps_partkey
      AND s_suppkey = ps_suppkey
      AND p_size = 15
      AND p_type LIKE '%BRASS'
      AND s_nationkey = n_nationkey
      AND n_regionkey = r_regionkey
      AND r_name = 'EUROPE'
      AND ps_supplycost = (
        SELECT MIN(ps_supplycost)
        FROM partsupp, supplier, nation, region
        WHERE p_partkey = ps_partkey
          AND s_suppkey = ps_suppkey
          AND s_nationkey = n_nationkey
          AND n_regionkey = r_regionkey
          AND r_name = 'EUROPE'
      )
    ORDER BY
      s_acctbal DESC,
      n_name,
      s_name,
      p_partkey
    LIMIT 100`,
  },

  // ─── Q3: Shipping Priority ──────────────────────────────────────
  {
    number: 3,
    name: 'Shipping Priority',
    description: 'Retrieves the unshipped orders with the highest revenue.',
    sql: `SELECT
      l_orderkey,
      SUM(l_extendedprice * (1 - l_discount)) AS revenue,
      o_orderdate,
      o_shippriority
    FROM
      customer,
      orders,
      lineitem
    WHERE
      c_mktsegment = 'BUILDING'
      AND c_custkey = o_custkey
      AND l_orderkey = o_orderkey
      AND o_orderdate < DATE '1995-03-15'
      AND l_shipdate > DATE '1995-03-15'
    GROUP BY
      l_orderkey,
      o_orderdate,
      o_shippriority
    ORDER BY
      revenue DESC,
      o_orderdate
    LIMIT 10`,
  },

  // ─── Q4: Order Priority Checking ─────────────────────────────────
  {
    number: 4,
    name: 'Order Priority Checking',
    description: 'Determines how well the order priority system is working.',
    sql: `SELECT
      o_orderpriority,
      COUNT(*) AS order_count
    FROM
      orders
    WHERE
      o_orderdate >= DATE '1993-07-01'
      AND o_orderdate < DATE '1993-07-01' + INTERVAL '3' MONTH
      AND EXISTS (
        SELECT *
        FROM lineitem
        WHERE l_orderkey = o_orderkey
          AND l_commitdate < l_receiptdate
      )
    GROUP BY
      o_orderpriority
    ORDER BY
      o_orderpriority`,
  },

  // ─── Q5: Local Supplier Volume ──────────────────────────────────
  {
    number: 5,
    name: 'Local Supplier Volume',
    description: 'Lists the revenue volume done through local suppliers.',
    sql: `SELECT
      n_name,
      SUM(l_extendedprice * (1 - l_discount)) AS revenue
    FROM
      customer,
      orders,
      lineitem,
      supplier,
      nation,
      region
    WHERE
      c_custkey = o_custkey
      AND l_orderkey = o_orderkey
      AND l_suppkey = s_suppkey
      AND c_nationkey = s_nationkey
      AND s_nationkey = n_nationkey
      AND n_regionkey = r_regionkey
      AND r_name = 'ASIA'
      AND o_orderdate >= DATE '1994-01-01'
      AND o_orderdate < DATE '1995-01-01'
    GROUP BY
      n_name
    ORDER BY
      revenue DESC`,
  },

  // ─── Q6: Forecasting Revenue Change ─────────────────────────────
  {
    number: 6,
    name: 'Forecasting Revenue Change',
    description: 'Quantifies the amount of revenue increase from a given discount.',
    sql: `SELECT
      SUM(l_extendedprice * l_discount) AS revenue
    FROM
      lineitem
    WHERE
      l_shipdate >= DATE '1994-01-01'
      AND l_shipdate < DATE '1995-01-01'
      AND l_discount BETWEEN 0.06 - 0.01 AND 0.06 + 0.01
      AND l_quantity < 24`,
  },

  // ─── Q7: Volume Shipping ────────────────────────────────────────
  {
    number: 7,
    name: 'Volume Shipping',
    description: 'Determines the value of goods shipped between nations.',
    sql: `SELECT
      supp_nation,
      cust_nation,
      l_year,
      SUM(volume) AS revenue
    FROM (
      SELECT
        n1.n_name AS supp_nation,
        n2.n_name AS cust_nation,
        EXTRACT(YEAR FROM l_shipdate) AS l_year,
        l_extendedprice * (1 - l_discount) AS volume
      FROM
        supplier,
        lineitem,
        orders,
        customer,
        nation n1,
        nation n2
      WHERE
        s_suppkey = l_suppkey
        AND o_orderkey = l_orderkey
        AND c_custkey = o_custkey
        AND s_nationkey = n1.n_nationkey
        AND c_nationkey = n2.n_nationkey
        AND (
          (n1.n_name = 'FRANCE' AND n2.n_name = 'GERMANY')
          OR (n1.n_name = 'GERMANY' AND n2.n_name = 'FRANCE')
        )
        AND l_shipdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
    ) AS shipping
    GROUP BY
      supp_nation,
      cust_nation,
      l_year
    ORDER BY
      supp_nation,
      cust_nation,
      l_year`,
  },

  // ─── Q8: National Market Share ──────────────────────────────────
  {
    number: 8,
    name: 'National Market Share',
    description: 'Determines the market share of a nation within a given region.',
    sql: `SELECT
      o_year,
      SUM(CASE
        WHEN nation = 'BRAZIL' THEN volume
        ELSE 0
      END) / SUM(volume) AS mkt_share
    FROM (
      SELECT
        EXTRACT(YEAR FROM o_orderdate) AS o_year,
        l_extendedprice * (1 - l_discount) AS volume,
        n2.n_name AS nation
      FROM
        part,
        supplier,
        lineitem,
        orders,
        customer,
        nation n1,
        nation n2,
        region
      WHERE
        p_partkey = l_partkey
        AND s_suppkey = l_suppkey
        AND l_orderkey = o_orderkey
        AND o_custkey = c_custkey
        AND c_nationkey = n1.n_nationkey
        AND n1.n_regionkey = r_regionkey
        AND r_name = 'AMERICA'
        AND s_nationkey = n2.n_nationkey
        AND o_orderdate BETWEEN DATE '1995-01-01' AND DATE '1996-12-31'
        AND p_type = 'ECONOMY ANODIZED STEEL'
    ) AS all_nations
    GROUP BY
      o_year
    ORDER BY
      o_year`,
  },

  // ─── Q9: Product Type Profit ────────────────────────────────────
  {
    number: 9,
    name: 'Product Type Profit Measure',
    description: 'Determines profit for a given year and region.',
    sql: `SELECT
      nation,
      o_year,
      SUM(amount) AS sum_profit
    FROM (
      SELECT
        n_name AS nation,
        EXTRACT(YEAR FROM o_orderdate) AS o_year,
        l_extendedprice * (1 - l_discount) - ps_supplycost * l_quantity AS amount
      FROM
        part,
        supplier,
        lineitem,
        partsupp,
        orders,
        nation
      WHERE
        s_suppkey = l_suppkey
        AND ps_suppkey = l_suppkey
        AND ps_partkey = l_partkey
        AND p_partkey = l_partkey
        AND o_orderkey = l_orderkey
        AND s_nationkey = n_nationkey
        AND p_name LIKE '%green%'
    ) AS profit
    GROUP BY
      nation,
      o_year
    ORDER BY
      nation,
      o_year DESC`,
  },

  // ─── Q10: Returned Item Reporting ───────────────────────────────
  {
    number: 10,
    name: 'Returned Item Reporting',
    description: 'Identifies customers who have returned items.',
    sql: `SELECT
      c_custkey,
      c_name,
      SUM(l_extendedprice * (1 - l_discount)) AS revenue,
      c_acctbal,
      n_name,
      c_address,
      c_phone,
      c_comment
    FROM
      customer,
      orders,
      lineitem,
      nation
    WHERE
      c_custkey = o_custkey
      AND l_orderkey = o_orderkey
      AND o_orderdate >= DATE '1993-10-01'
      AND o_orderdate < DATE '1994-01-01'
      AND l_returnflag = 'R'
      AND c_nationkey = n_nationkey
    GROUP BY
      c_custkey,
      c_name,
      c_acctbal,
      c_phone,
      n_name,
      c_address,
      c_comment
    ORDER BY
      revenue DESC
    LIMIT 20`,
  },

  // ─── Q11: Important Stock Identification ─────────────────────────
  {
    number: 11,
    name: 'Important Stock Identification',
    description: 'Finds the most important suppliers of a given nation.',
    sql: `SELECT
      ps_partkey,
      SUM(ps_supplycost * ps_availqty) AS value
    FROM
      partsupp,
      supplier,
      nation
    WHERE
      ps_suppkey = s_suppkey
      AND s_nationkey = n_nationkey
      AND n_name = 'GERMANY'
    GROUP BY
      ps_partkey
    HAVING
      SUM(ps_supplycost * ps_availqty) > (
        SELECT SUM(ps_supplycost * ps_availqty) * 0.0001
        FROM partsupp, supplier, nation
        WHERE ps_suppkey = s_suppkey
          AND s_nationkey = n_nationkey
          AND n_name = 'GERMANY'
      )
    ORDER BY
      value DESC`,
  },

  // ─── Q12: Shipping Modes and Order Priority ─────────────────────
  {
    number: 12,
    name: 'Shipping Modes and Order Priority',
    description: 'Examines the effect of shipping modes on order priorities.',
    sql: `SELECT
      l_shipmode,
      SUM(CASE
        WHEN o_orderpriority = '1-URGENT'
          OR o_orderpriority = '2-HIGH'
        THEN 1
        ELSE 0
      END) AS high_line_count,
      SUM(CASE
        WHEN o_orderpriority <> '1-URGENT'
          AND o_orderpriority <> '2-HIGH'
        THEN 1
        ELSE 0
      END) AS low_line_count
    FROM
      orders,
      lineitem
    WHERE
      o_orderkey = l_orderkey
      AND l_shipmode IN ('MAIL', 'SHIP')
      AND l_commitdate < l_receiptdate
      AND l_shipdate < l_commitdate
      AND l_receiptdate >= DATE '1994-01-01'
      AND l_receiptdate < DATE '1995-01-01'
    GROUP BY
      l_shipmode
    ORDER BY
      l_shipmode`,
  },

  // ─── Q13: Customer Distribution ─────────────────────────────────
  {
    number: 13,
    name: 'Customer Distribution',
    description: 'Determines the distribution of customers by the number of orders.',
    sql: `SELECT
      c_count,
      COUNT(*) AS custdist
    FROM (
      SELECT
        c_custkey,
        COUNT(o_orderkey) AS c_count
      FROM
        customer LEFT OUTER JOIN orders ON
          c_custkey = o_custkey
          AND o_comment NOT LIKE '%special%requests%'
      GROUP BY
        c_custkey
    ) AS c_orders
    GROUP BY
      c_count
    ORDER BY
      custdist DESC,
      c_count DESC`,
  },

  // ─── Q14: Promotion Effect ──────────────────────────────────────
  {
    number: 14,
    name: 'Promotion Effect',
    description: 'Calculates the market share of promoted parts.',
    sql: `SELECT
      100.00 * SUM(CASE
        WHEN p_type LIKE 'PROMO%'
        THEN l_extendedprice * (1 - l_discount)
        ELSE 0
      END) / SUM(l_extendedprice * (1 - l_discount)) AS promo_revenue
    FROM
      lineitem,
      part
    WHERE
      l_partkey = p_partkey
      AND l_shipdate >= DATE '1995-09-01'
      AND l_shipdate < DATE '1995-10-01'`,
  },

  // ─── Q15: Top Supplier ──────────────────────────────────────────
  {
    number: 15,
    name: 'Top Supplier',
    description: 'Finds the supplier with the greatest total revenue.',
    sql: `WITH revenue_view AS (
      SELECT
        l_suppkey AS supplier_no,
        SUM(l_extendedprice * (1 - l_discount)) AS total_revenue
      FROM
        lineitem
      WHERE
        l_shipdate >= DATE '1996-01-01'
        AND l_shipdate < DATE '1996-04-01'
      GROUP BY
        l_suppkey
    )
    SELECT
      s_suppkey,
      s_name,
      s_address,
      s_phone,
      total_revenue
    FROM
      supplier,
      revenue_view
    WHERE
      s_suppkey = supplier_no
      AND total_revenue = (SELECT MAX(total_revenue) FROM revenue_view)
    ORDER BY
      s_suppkey`,
  },

  // ─── Q16: Part/Supplier Relationship ────────────────────────────
  {
    number: 16,
    name: 'Part/Supplier Relationship',
    description: 'Counts suppliers who can supply parts with given attributes.',
    sql: `SELECT
      p_brand,
      p_type,
      p_size,
      COUNT(DISTINCT ps_suppkey) AS supplier_cnt
    FROM
      partsupp,
      part
    WHERE
      p_partkey = ps_partkey
      AND p_brand <> 'Brand#45'
      AND p_type NOT LIKE 'MEDIUM POLISHED%'
      AND p_size IN (49, 14, 23, 45, 19, 3, 36, 9)
      AND ps_suppkey NOT IN (
        SELECT s_suppkey
        FROM supplier
        WHERE s_comment LIKE '%Customer%Complaints%'
      )
    GROUP BY
      p_brand,
      p_type,
      p_size
    ORDER BY
      supplier_cnt DESC,
      p_brand,
      p_type,
      p_size`,
  },

  // ─── Q17: Small-Quantity-Order Revenue ──────────────────────────
  {
    number: 17,
    name: 'Small-Quantity-Order Revenue',
    description: 'Determines revenue lost due to small-quantity orders.',
    sql: `SELECT
      SUM(l_extendedprice) / 7.0 AS avg_yearly
    FROM
      lineitem,
      part
    WHERE
      p_partkey = l_partkey
      AND p_brand = 'Brand#23'
      AND p_container = 'MED BOX'
      AND l_quantity < (
        SELECT 0.2 * AVG(l_quantity)
        FROM lineitem
        WHERE l_partkey = p_partkey
      )`,
  },

  // ─── Q18: Large Volume Customer ─────────────────────────────────
  {
    number: 18,
    name: 'Large Volume Customer',
    description: 'Finds customers with large total order volumes.',
    sql: `SELECT
      c_name,
      c_custkey,
      o_orderkey,
      o_orderdate,
      o_totalprice,
      SUM(l_quantity) AS total_quantity
    FROM
      customer,
      orders,
      lineitem
    WHERE
      o_orderkey IN (
        SELECT l_orderkey
        FROM lineitem
        GROUP BY l_orderkey
        HAVING SUM(l_quantity) > 300
      )
      AND c_custkey = o_custkey
      AND o_orderkey = l_orderkey
    GROUP BY
      c_name,
      c_custkey,
      o_orderkey,
      o_orderdate,
      o_totalprice
    ORDER BY
      o_totalprice DESC,
      o_orderdate
    LIMIT 100`,
  },

  // ─── Q19: Discounted Revenue ────────────────────────────────────
  {
    number: 19,
    name: 'Discounted Revenue',
    description: 'Calculates the total discounted revenue for selected parts.',
    sql: `SELECT
      SUM(l_extendedprice * (1 - l_discount)) AS revenue
    FROM
      lineitem,
      part
    WHERE
      p_partkey = l_partkey
      AND (
        (
          p_brand = 'Brand#12'
          AND p_container IN ('SM CASE', 'SM BOX', 'SM PACK', 'SM PKG')
          AND l_quantity >= 1 AND l_quantity <= 11
          AND p_size BETWEEN 1 AND 5
          AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        )
        OR (
          p_brand = 'Brand#23'
          AND p_container IN ('MED BAG', 'MED BOX', 'MED PKG', 'MED PACK')
          AND l_quantity >= 10 AND l_quantity <= 20
          AND p_size BETWEEN 1 AND 10
          AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        )
        OR (
          p_brand = 'Brand#34'
          AND p_container IN ('LG CASE', 'LG BOX', 'LG PACK', 'LG PKG')
          AND l_quantity >= 20 AND l_quantity <= 30
          AND p_size BETWEEN 1 AND 15
          AND l_shipmode IN ('AIR', 'AIR REG')
          AND l_shipinstruct = 'DELIVER IN PERSON'
        )
      )`,
  },

  // ─── Q20: Potential Part Promotion ──────────────────────────────
  {
    number: 20,
    name: 'Potential Part Promotion',
    description: 'Identifies suppliers with excess inventory of given parts.',
    sql: `SELECT
      s_name,
      s_address
    FROM
      supplier,
      nation
    WHERE
      s_suppkey IN (
        SELECT ps_suppkey
        FROM partsupp
        WHERE ps_partkey IN (
          SELECT p_partkey
          FROM part
          WHERE p_name LIKE 'forest%'
        )
        AND ps_availqty > (
          SELECT 0.5 * SUM(l_quantity)
          FROM lineitem
          WHERE l_partkey = ps_partkey
            AND l_suppkey = ps_suppkey
            AND l_shipdate >= DATE '1994-01-01'
            AND l_shipdate < DATE '1995-01-01'
        )
      )
      AND s_nationkey = n_nationkey
      AND n_name = 'CANADA'
    ORDER BY
      s_name`,
  },

  // ─── Q21: Suppliers Who Kept Orders Waiting ─────────────────────
  {
    number: 21,
    name: 'Suppliers Who Kept Orders Waiting',
    description: 'Finds suppliers whose orders were delayed.',
    sql: `SELECT
      s_name,
      COUNT(*) AS numwait
    FROM
      supplier,
      lineitem l1,
      orders,
      nation
    WHERE
      s_suppkey = l1.l_suppkey
      AND o_orderkey = l1.l_orderkey
      AND o_orderstatus = 'F'
      AND l1.l_receiptdate > l1.l_commitdate
      AND EXISTS (
        SELECT *
        FROM lineitem l2
        WHERE l2.l_orderkey = l1.l_orderkey
          AND l2.l_suppkey <> l1.l_suppkey
      )
      AND NOT EXISTS (
        SELECT *
        FROM lineitem l3
        WHERE l3.l_orderkey = l1.l_orderkey
          AND l3.l_suppkey <> l1.l_suppkey
          AND l3.l_receiptdate > l3.l_commitdate
      )
      AND s_nationkey = n_nationkey
      AND n_name = 'SAUDI ARABIA'
    GROUP BY
      s_name
    ORDER BY
      numwait DESC,
      s_name
    LIMIT 100`,
  },

  // ─── Q22: Global Sales Opportunity ──────────────────────────────
  {
    number: 22,
    name: 'Global Sales Opportunity',
    description: 'Identifies potential geographical sales expansion.',
    sql: `SELECT
      cntrycode,
      COUNT(*) AS numcust,
      SUM(c_acctbal) AS totacctbal
    FROM (
      SELECT
        SUBSTRING(c_phone, 1, 2) AS cntrycode,
        c_acctbal
      FROM
        customer
      WHERE
        SUBSTRING(c_phone, 1, 2) IN ('13', '31', '23', '29', '30', '18', '17')
        AND c_acctbal > (
          SELECT AVG(c_acctbal)
          FROM customer
          WHERE c_acctbal > 0.00
            AND SUBSTRING(c_phone, 1, 2) IN ('13', '31', '23', '29', '30', '18', '17')
        )
        AND NOT EXISTS (
          SELECT *
          FROM orders
          WHERE o_custkey = c_custkey
        )
    ) AS custsale
    GROUP BY
      cntrycode
    ORDER BY
      cntrycode`,
  },
];
