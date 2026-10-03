import { useState } from 'react';
import useSWR from 'swr';
import { apiFetcher } from '../lib/api';
import { canManageOrders, canReceiveOrderNotifications } from '../lib/orderAccess';

export function useManagerOrders(currentUser, onOrders) {
  const receivesNotifications = canReceiveOrderNotifications(currentUser);
  const userScope = receivesNotifications ? JSON.stringify([currentUser.id, currentUser.group_id, currentUser.role]) : null;
  // Share the handoff poll with notifications. The API restricts managers to
  // their assigned group; chiefs/admins receive orders from all groups.
  const url = canManageOrders(currentUser) ? '/api/manager/orders?status=pending' : '/api/notifications/orders';
  const key = receivesNotifications
    ? [url, userScope]
    : null;
  const [lastUpdate, setLastUpdate] = useState({ key: null, value: null });

  const { data, error, isLoading, isValidating, mutate } = useSWR(key, apiFetcher, {
    refreshInterval: 5000,
    dedupingInterval: 4000,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    revalidateOnFocus: true,
    onSuccess: (payload) => {
      setLastUpdate({ key: userScope, value: new Date() });
      onOrders?.(payload?.data || [], userScope, payload?.notification_history_revision);
    },
  });

  return {
    orders: data?.data || [],
    error,
    isLoading,
    isRefreshing: isValidating && !isLoading,
    lastUpdated: lastUpdate?.key === userScope ? lastUpdate.value : null,
    refresh: mutate,
  };
}
