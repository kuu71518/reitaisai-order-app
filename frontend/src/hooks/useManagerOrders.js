import { useState } from 'react';
import useSWR from 'swr';
import { apiFetcher } from '../lib/api';
import { canManageOrders } from '../lib/orderAccess';

export function useManagerOrders(currentUser, onOrders) {
  const isManager = canManageOrders(currentUser);
  const userScope = isManager ? JSON.stringify([currentUser.id, currentUser.group_id, currentUser.role]) : null;
  const key = isManager
    ? ['/api/manager/orders?status=pending', userScope]
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
