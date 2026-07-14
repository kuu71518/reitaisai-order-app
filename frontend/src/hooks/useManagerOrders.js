import { useState } from 'react';
import useSWR from 'swr';
import { apiFetcher } from '../lib/api';

export function useManagerOrders(currentUser, onOrders) {
  const isManager = currentUser?.role === 'manager';
  const key = isManager
    ? '/api/manager/orders?status=pending'
    : null;
  const [lastUpdate, setLastUpdate] = useState({ key: null, value: null });

  const { data, error, isLoading, isValidating, mutate } = useSWR(key, apiFetcher, {
    refreshInterval: 5000,
    dedupingInterval: 4000,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
    revalidateOnFocus: true,
    onSuccess: (payload) => {
      setLastUpdate({ key, value: new Date() });
      onOrders?.(payload?.data || []);
    },
  });

  return {
    orders: data?.data || [],
    error,
    isLoading,
    isRefreshing: isValidating && !isLoading,
    lastUpdated: lastUpdate?.key === key ? lastUpdate.value : null,
    refresh: mutate,
  };
}
