"""Shared rules for changing an elder's current service location."""

from typing import Any


UNFINISHED_ORDER_STATUSES = ("pending", "accepted", "in_progress")


def find_unfinished_elder_order(cursor: Any, elder_id: int) -> dict[str, Any] | None:
    """Return the newest order that still owns the elder's service location."""
    cursor.execute(
        """
        SELECT order_id, service_type, status
        FROM orders
        WHERE elder_id = %s
          AND status IN ('pending', 'accepted', 'in_progress')
        ORDER BY order_id DESC
        LIMIT 1
        """,
        (int(elder_id),),
    )
    return cursor.fetchone()


def location_change_block_message(order: dict[str, Any]) -> str:
    order_id = int(order["order_id"])
    service_type = str(order.get("service_type") or "服务订单")
    return (
        f"当前有未结束订单 #{order_id}（{service_type}），"
        "为避免服务地点与志愿者导航不一致，请在订单完成或取消后再更新位置。"
    )
