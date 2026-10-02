import { useState } from 'react';
import useSWR from 'swr';
import { apiFetcher } from '../lib/api';
import { canManageOrders, canReceiveOrderNotifications } from '../lib/orderAccess';

export function useManagerOrders(currentUser, onOrders) {
  const receivesNotifications = canReceiveOrderNotifications(currentUser);
  const userScope = receivesNotifications ? JSON.stringify([currentUser.id, currentUser.group_id, currentUser.role]) : null;
  // Chiefs/admins share their handoff poll with notifications. Managers poll
  // only IDs, so their browser never receives individual handoff information.
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
      onOrders?.(payload?.data || []);
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
